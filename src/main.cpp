/* =========================================================================
 * SMART LOCKER - NHÓM 6
 * ESP32 không giữ mã OTP. Người dùng nhập 6 số trên keypad, bấm #,
 * ESP32 gửi {req, code} lên MQTT; web kiểm tra và trả kết quả.
 * Đúng -> mở relay. Sai / khóa / mất kết nối -> báo trên OLED + còi.
 *
 * Keypad: 0-9 nhập · # xác nhận · * xóa 1 số · D xóa hết
 * Toàn bộ vòng lặp không chặn (không delay) để bàn phím luôn phản hồi.
 * ========================================================================= */
#include <Arduino.h>
#include "config.h"
#include "hardware.h"
#include "keypad.h"
#include "net.h"
#include "ui.h"

enum State { ST_IDLE, ST_INPUT, ST_WAITING, ST_UNLOCKED, ST_MESSAGE, ST_LOCKOUT };

static State state = ST_IDLE;
static unsigned long stateSince = 0;

static char input[OTP_LENGTH + 1] = "";
static uint8_t inputLen = 0;
static char pendingReq[9] = "";

static Screen messageScreen = SCR_IDLE;  // màn đang hiện trong ST_MESSAGE
static int messageNumber = 0;
static unsigned long lockoutUntil = 0;

static bool doorOpen = false;
static bool doorOpenedWhileUnlocked = false;

// ---------------------------------------------------------------------------
static void enter(State s) {
  state = s;
  stateSince = millis();
}

static void clearInput() {
  memset(input, 0, sizeof(input));
  inputLen = 0;
}

// Về màn chờ, nhưng vẫn giữ đếm ngược nếu bàn phím đang bị khóa
static void backToIdle() {
  enter((long)(millis() - lockoutUntil) < 0 ? ST_LOCKOUT : ST_IDLE);
}

static void showMessage(Screen scr, int number) {
  messageScreen = scr;
  messageNumber = number;
  enter(ST_MESSAGE);
}

static void unlock(const char* source) {
  clearInput();
  pendingReq[0] = '\0';
  doorOpenedWhileUnlocked = false;
  hwSetRelay(true);
  hwPlay(SND_OK);
  enter(ST_UNLOCKED);
  Serial.printf("[LOCK] Mo khoa (nguon: %s)\n", source);
  netPublishEvent("UNLOCKED", source);
  netPublishStatus(true, doorOpen);
}

static void lock(const char* source) {
  hwSetRelay(false);
  enter(ST_IDLE);
  Serial.printf("[LOCK] Da khoa (nguon: %s)\n", source);
  netPublishEvent("LOCKED", source);
  netPublishStatus(false, doorOpen);
}

// ---------------------------------------------------------------------------
// Callback từ net.cpp
static void onVerifyResult(const VerifyResult& r) {
  if (state != ST_WAITING || strcmp(r.req, pendingReq) != 0) return;  // kết quả cũ / lạc
  pendingReq[0] = '\0';
  clearInput();

  if (r.ok) {
    unlock("OTP");
  } else if (strcmp(r.reason, "LOCKED_OUT") == 0) {
    lockoutUntil = millis() + (unsigned long)max(r.retryIn, 1) * 1000UL;
    hwPlay(SND_ALARM);
    enter(ST_LOCKOUT);
  } else if (strcmp(r.reason, "NO_OTP") == 0) {
    hwPlay(SND_ERROR);
    showMessage(SCR_NO_OTP, 0);
  } else {
    hwPlay(SND_ERROR);
    showMessage(SCR_DENIED, r.attemptsLeft);
  }
}

static void onUnlockCommand() {
  if (state != ST_UNLOCKED) unlock("REMOTE");
}

// ---------------------------------------------------------------------------
static void submit() {
  if (!netConnected()) {
    clearInput();
    hwPlay(SND_ERROR);
    showMessage(SCR_OFFLINE, 0);
    return;
  }
  snprintf(pendingReq, sizeof(pendingReq), "%08lx", (unsigned long)esp_random());
  if (!netSendVerify(pendingReq, input)) {
    pendingReq[0] = '\0';
    clearInput();
    hwPlay(SND_ERROR);
    showMessage(SCR_OFFLINE, 0);
    return;
  }
  enter(ST_WAITING);
}

static void handleKey(char key) {
  // Chỉ nhận phím khi đang chờ nhập; màn thông báo được bỏ qua bằng phím bất kỳ
  if (state == ST_MESSAGE) backToIdle();
  if (state != ST_IDLE && state != ST_INPUT) return;

  hwPlay(SND_KEY);
  if (key >= '0' && key <= '9') {
    if (inputLen < OTP_LENGTH) {
      input[inputLen++] = key;
      input[inputLen] = '\0';
    }
    enter(ST_INPUT);
  } else if (key == '*') {
    if (inputLen > 0) input[--inputLen] = '\0';
    enter(inputLen ? ST_INPUT : ST_IDLE);
  } else if (key == 'D') {
    clearInput();
    enter(ST_IDLE);
  } else if (key == '#') {
    if (inputLen == OTP_LENGTH) submit();
    else hwPlay(SND_ERROR);
  }
}

static void handleDoor() {
  bool open = hwDoorOpen();
  if (open == doorOpen) return;
  doorOpen = open;
  netPublishEvent(open ? "DOOR_OPENED" : "DOOR_CLOSED", "SENSOR");
  netPublishStatus(state == ST_UNLOCKED, doorOpen);

  if (open) {
    if (state == ST_UNLOCKED) {
      doorOpenedWhileUnlocked = true;
    } else {
      Serial.println(F("[ALERT] Cua bi mo khi dang khoa - nghi cay cua!"));
      hwPlay(SND_ALARM);
      netPublishEvent("TAMPER", "SENSOR");
      pendingReq[0] = '\0';
      clearInput();
      showMessage(SCR_TAMPER, 0);
    }
  } else if (state == ST_UNLOCKED && doorOpenedWhileUnlocked) {
    lock("DOOR_CLOSED");
  }
}

static void handleTimers() {
  unsigned long now = millis();
  switch (state) {
    case ST_WAITING:
      if (now - stateSince >= VERIFY_TIMEOUT_MS) {
        Serial.println(F("[VERIFY] Qua 5s khong co phan hoi tu web"));
        pendingReq[0] = '\0';
        clearInput();
        hwPlay(SND_ERROR);
        showMessage(SCR_OFFLINE, 0);
      }
      break;
    case ST_UNLOCKED:
      if (!doorOpenedWhileUnlocked && now - stateSince >= UNLOCK_DURATION_MS) lock("TIMEOUT");
      break;
    case ST_MESSAGE:
      if (now - stateSince >= MESSAGE_SHOW_MS) backToIdle();
      break;
    case ST_LOCKOUT:
      if ((long)(now - lockoutUntil) >= 0) enter(ST_IDLE);
      break;
    default:
      break;
  }
}

static void render() {
  bool online = netConnected();
  unsigned long now = millis();
  switch (state) {
    case ST_IDLE:
      uiDraw(SCR_IDLE, 0, online);
      break;
    case ST_INPUT:
      uiDraw(SCR_INPUT, inputLen, online);
      break;
    case ST_WAITING:
      uiDraw(SCR_WAITING, 0, online);
      break;
    case ST_UNLOCKED: {
      int left = doorOpenedWhileUnlocked ? -1 : (int)((UNLOCK_DURATION_MS - (now - stateSince) + 999) / 1000);
      uiDraw(SCR_UNLOCKED, left, online);
      break;
    }
    case ST_MESSAGE:
      uiDraw(messageScreen, messageNumber, online);
      break;
    case ST_LOCKOUT:
      uiDraw(SCR_LOCKOUT, (int)((lockoutUntil - now + 999) / 1000), online);
      break;
  }
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.println(F("\n=== SMART LOCKER - NHOM 6 (xac thuc OTP qua web) ==="));

  hwBegin();
  keypadBegin();
  uiBegin();
  doorOpen = hwDoorOpen();  // đọc trạng thái thật, tránh báo cạy cửa nhầm lúc khởi động
  netBegin(onVerifyResult, onUnlockCommand);
  netPublishStatus(false, doorOpen);
  enter(ST_IDLE);
}

void loop() {
  netLoop();
  hwUpdate();
  hwSetLedFast(!netConnected());

  char key = keypadGetKey();
  if (key) handleKey(key);

  handleDoor();
  handleTimers();
  render();
}
