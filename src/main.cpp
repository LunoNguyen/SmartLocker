#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include "config.h"

/* =========================================================================
 * CHỦ ĐỀ 67: TỦ KHÓA GIAO HÀNG THÔNG MINH SMART LOCKER - NHÓM 6
 * Nâng cấp:
 * 1. Khóa vĩnh viễn OTP sau 1 lần mở (Single-Use OTP Locking).
 * 2. Tự động/thủ công tái kích hoạt mã OTP ngẫu nhiên mới (A = Sinh mã mới).
 * 3. Tích hợp RabbitMQ / Local MQTT Message Broker (User: luno, Pass: luno).
 * 4. Cấu hình MQTT tập trung trong config.h dễ dàng thay đổi khi dùng Local.
 * 5. Cơ chế Lũy tuyến (Exponential Backoff) & Anomaly Tamper Engine.
 * ========================================================================= */

// --- PIN DEFINITIONS (Khớp chuẩn 100% diagram.json) ---
#define OLED_SDA        21
#define OLED_SCL        22
#define SCREEN_WIDTH    128
#define SCREEN_HEIGHT   64
#define OLED_RESET      -1
#define SCREEN_ADDRESS  0x3C

// Keypad 4x4 pins
const byte KEYPAD_ROWS = 4;
const byte KEYPAD_COLS = 4;
const byte rowPins[KEYPAD_ROWS] = {13, 12, 14, 27};
const byte colPins[KEYPAD_COLS] = {26, 25, 33, 32};
const char keyMap[KEYPAD_ROWS][KEYPAD_COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};

// Peripheral Pins
#define QR_RX_PIN       17  // ESP32 RX2 <- qrreader1 TXD
#define QR_TX_PIN       16  // ESP32 TX2 -> qrreader1 RXD
#define RELAY_PIN       23  // Điều khiển Solenoid Lock (HIGH = Mở chốt, LOW = Khóa)
#define DOOR_PIN        18  // Cảm biến từ cửa (INPUT_PULLUP: LOW = Đóng, HIGH = Mở)
#define BUZZER_PIN      15  // Còi cảnh báo / Âm phản hồi phím
#define STATUS_LED      2   // LED trạng thái hệ thống

// Display
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// Client MQTT & WiFi
WiFiClient espWifiClient;
PubSubClient mqttClient(espWifiClient);

// Định danh phần cứng
String deviceMacAddress = "";

// --- TRẠNG THÁI VẬT LÝ VÀ AN NINH ---
enum SystemState {
  STATE_IDLE,
  STATE_INPUT_OTP,
  STATE_UNLOCKED,
  STATE_QUARANTINED
};

SystemState currentState = STATE_IDLE;

bool isUnlocked = false;
bool isDoorOpen = false;
bool lastDoorState = false;
unsigned long unlockTimestamp = 0;
unsigned long doorOpenedTimestamp = 0;

// Bộ đếm sử dụng
unsigned int doorOpenCount = 0;

// --- QUẢN LÝ MÃ OTP 1 LẦN (SINGLE-USE OTP) ---
String activeOtp = "123456";          // Mã OTP hiện hành
bool isOtpActive = true;              // Cờ trạng thái: Đang hiệu lực hay đã bị khóa
String currentPackageId = "PKG-7821"; // Mã kiện hàng gắn với OTP
String adminMasterPin = "9999";       // PIN quản trị cứu hộ cục bộ

// --- SUB-SYSTEM CIRCUIT BREAKERS (Khoanh vùng ngắt nguồn/cô lập) ---
struct CircuitBreakers {
  bool qr_reader = true;
  bool keypad = true;
  bool cloud_sync = true;
  bool lock_actuator = true;
};
CircuitBreakers breakers;

// Cờ cách ly khẩn cấp (Quarantine Mode)
bool isQuarantined = false;

// --- ANOMALY & SECURITY TRACKER ---
unsigned int failedOtpAttempts = 0;
unsigned long lockoutUntil = 0;
bool isBreakInDetected = false;
bool isDoorAjarAlerted = false;

// Buffer nhập từ bàn phím và QR
String enteredPin = "";
String qrInputBuffer = "";

// --- CƠ CHẾ LŨY TUYẾN (EXPONENTIAL BACKOFF) & SYNC ---
unsigned long syncIntervalMs = 2000;       // Khởi đầu 2s
const unsigned long MIN_SYNC_INTERVAL = 2000;
const unsigned long MAX_SYNC_INTERVAL = 64000;
unsigned long lastSyncTime = 0;
unsigned int consecutiveSuccesses = 0;
unsigned int consecutiveErrors = 0;

// MQTT Reconnection Tracker
unsigned long lastMqttReconnectAttempt = 0;

// LED Heartbeat Timer
unsigned long lastHeartbeatTime = 0;
bool ledState = false;

// --- NGUYÊN MẪU HÀM ---
void setupPins();
void setupKeypad();
char scanKeypad();
void updateOledUI();
void playTone(int freq, int duration);
void playSuccessChime();
void playErrorChime();
void playAlarmSiren();
void handleKeyInput(char key);
void handleQrCodeInput();
void executeUnlock(const String& method, const String& details);
void executeLock();
void generateNewRandomOtp(const String& source);
void deleteCurrentOtp(const String& source);
void checkSensorsAndAnomalies();
void triggerQuarantine(const String& reason);
void restoreFromQuarantine();
void syncDeviceShadowAndTelemetry();
void sendAuditLogToDbDirect(const String& level, const String& event, const String& details);

// MQTT Functions
void setupMqtt();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishMqttEvent(const String& eventType, const String& details);
void publishMqttStatus();

// =========================================================================
// SETUP
// =========================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println(F("\n======================================================="));
  Serial.println(F("🚀 SMART LOCKER - RABBITMQ MQTT & ONE-TIME OTP (NHÓM 6)"));
  Serial.println(F("======================================================="));

  setupPins();
  setupKeypad();

  // Khởi động cổng UART2 cho đầu đọc QR (RX=17, TX=16)
  Serial2.begin(9600, SERIAL_8N1, QR_RX_PIN, QR_TX_PIN);

  // Khởi tạo I2C và OLED SSD1306
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("[LỖI] Không thể kết nối OLED SSD1306!"));
  } else {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println(F("SMART LOCKER N6"));
    display.println(F("Ket noi RabbitMQ..."));
    display.display();
  }

  // Kết nối WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print(F("[WIFI] Dang ket noi WiFi: "));
  Serial.println(WIFI_SSID);

  unsigned long startWifi = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startWifi < 6000)) {
    delay(300);
    Serial.print(".");
  }

  deviceMacAddress = WiFi.macAddress();
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("[WIFI] Da ket noi! IP: "));
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(F("[WIFI] Offline Mode (Tam thoi khong co WiFi)."));
  }

  Serial.print(F("[BAO MAT VAT LY] Hardware MAC: "));
  Serial.println(deviceMacAddress);

  // Cấu hình MQTT RabbitMQ
  setupMqtt();

  // Khởi tạo hạt giống ngẫu nhiên từ nhiễu analog chân GPIO 34
  randomSeed(analogRead(34) + millis());

  // Tiếng bíp khởi động thành công
  playSuccessChime();

  // Đọc trạng thái ban đầu của cảm biến cửa
  isDoorOpen = (digitalRead(DOOR_PIN) == HIGH);
  lastDoorState = isDoorOpen;

  updateOledUI();
}

// =========================================================================
// MAIN LOOP
// =========================================================================
void loop() {
  unsigned long now = millis();

  // 1. Quản lý kết nối MQTT RabbitMQ (Không block chương trình)
  if (WiFi.status() == WL_CONNECTED && breakers.cloud_sync) {
    if (!mqttClient.connected()) {
      if (now - lastMqttReconnectAttempt > 5000) {
        lastMqttReconnectAttempt = now;
        reconnectMqtt();
      }
    } else {
      mqttClient.loop();
    }
  }

  // 2. Quét cảm biến vật lý & kiểm toán an ninh liên tục
  checkSensorsAndAnomalies();

  // 3. Quét đầu đọc QR Scanner (nếu breaker cho phép)
  if (breakers.qr_reader && !isQuarantined) {
    handleQrCodeInput();
  }

  // 4. Quét bàn phím ma trận (nếu breaker cho phép và không bị khóa tạm)
  if (breakers.keypad && !isQuarantined) {
    if (now >= lockoutUntil) {
      char key = scanKeypad();
      if (key != 0) {
        handleKeyInput(key);
      }
    }
  }

  // 5. Tự động đóng chốt khóa khi hết thời gian mở
  if (isUnlocked) {
    if (now - unlockTimestamp >= UNLOCK_DURATION_MS) {
      executeLock();
    }
  }

  // 6. Đồng bộ Device Shadow & Đo lường Lũy tuyến (Exponential Backoff)
  if (breakers.cloud_sync) {
    if (now - lastSyncTime >= syncIntervalMs) {
      lastSyncTime = now;
      syncDeviceShadowAndTelemetry();
    }
  }

  // 7. Nhịp tim LED trạng thái (Heartbeat)
  unsigned long heartbeatPeriod = isQuarantined ? 150 : (syncIntervalMs > MIN_SYNC_INTERVAL ? 1500 : 800);
  if (now - lastHeartbeatTime >= heartbeatPeriod) {
    lastHeartbeatTime = now;
    ledState = !ledState;
    digitalWrite(STATUS_LED, ledState ? HIGH : LOW);
  }

  delay(20);
}

// =========================================================================
// THIẾT LẬP PHẦN CỨNG & BÀN PHÍM
// =========================================================================
void setupPins() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW); // Mặc định khóa

  pinMode(DOOR_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);
}

void setupKeypad() {
  for (byte i = 0; i < KEYPAD_ROWS; i++) {
    pinMode(rowPins[i], OUTPUT);
    digitalWrite(rowPins[i], HIGH);
  }
  for (byte j = 0; j < KEYPAD_COLS; j++) {
    pinMode(colPins[j], INPUT_PULLUP);
  }
}

char scanKeypad() {
  for (byte r = 0; r < KEYPAD_ROWS; r++) {
    digitalWrite(rowPins[r], LOW);
    for (byte c = 0; c < KEYPAD_COLS; c++) {
      if (digitalRead(colPins[c]) == LOW) {
        delay(25); // Debounce
        if (digitalRead(colPins[c]) == LOW) {
          playTone(2200, 25);
          while (digitalRead(colPins[c]) == LOW) delay(10);
          digitalWrite(rowPins[r], HIGH);
          return keyMap[r][c];
        }
      }
    }
    digitalWrite(rowPins[r], HIGH);
  }
  return 0;
}

// =========================================================================
// ÂM THANH BUZZER
// =========================================================================
void playTone(int freq, int duration) {
  tone(BUZZER_PIN, freq, duration);
}

void playSuccessChime() {
  tone(BUZZER_PIN, 1500, 100);
  delay(120);
  tone(BUZZER_PIN, 2500, 200);
}

void playErrorChime() {
  tone(BUZZER_PIN, 450, 400);
}

void playAlarmSiren() {
  for (int f = 1000; f < 3000; f += 200) {
    tone(BUZZER_PIN, f, 15);
    delay(15);
  }
}

// =========================================================================
// MQTT RABBITMQ INTEGRATION
// =========================================================================
void setupMqtt() {
  mqttClient.setServer(MQTT_BROKER_HOST, MQTT_BROKER_PORT);
  mqttClient.setCallback(mqttCallback);
  Serial.print(F("[MQTT] Broker cau hinh tai: "));
  Serial.print(MQTT_BROKER_HOST);
  Serial.print(F(":"));
  Serial.println(MQTT_BROKER_PORT);
}

void reconnectMqtt() {
  if (mqttClient.connected()) return;

  Serial.print(F("[MQTT] Dang ket noi RabbitMQ (User: "));
  Serial.print(MQTT_USERNAME);
  Serial.println(F(")..."));

  if (mqttClient.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD)) {
    Serial.println(F("✅ [MQTT] Ket noi RabbitMQ thanh cong!"));
    // Dang ky nhan lenh dieu khien tu xa
    mqttClient.subscribe(MQTT_TOPIC_COMMAND);
    Serial.print(F("[MQTT] Da dang ky lang nghe topic: "));
    Serial.println(MQTT_TOPIC_COMMAND);

    publishMqttStatus();
  } else {
    Serial.print(F("⚠️ [MQTT] Ket noi that bai, ma loi rc="));
    Serial.println(mqttClient.state());
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.print(F("[MQTT NHAN TIN] Topic: "));
  Serial.print(topic);
  Serial.print(F(" | Noi dung: "));
  Serial.println(message);

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, message);
  if (err) {
    // Neu la chuoi lenh truc tiep
    if (message == "UNLOCK") {
      executeUnlock("MQTT_COMMAND", "Lenh mo truc tiep qua RabbitMQ");
    } else if (message == "NEW_OTP" || message == "GENERATE_OTP") {
      generateNewRandomOtp("MQTT_BROKER");
    } else if (message == "DELETE_OTP" || message == "REVOKE_OTP" || message == "DEL") {
      deleteCurrentOtp("MQTT_BROKER");
    } else if (message == "ISOLATE") {
      triggerQuarantine("MQTT_REMOTE_COMMAND");
    } else if (message == "UNISOLATE") {
      restoreFromQuarantine();
    }
    return;
  }

  // Parse JSON Command
  if (doc.containsKey("command")) {
    String cmd = doc["command"].as<String>();
    if (cmd == "UNLOCK") {
      executeUnlock("MQTT_COMMAND", "Lenh mo JSON qua RabbitMQ");
    } else if (cmd == "NEW_OTP" || cmd == "GENERATE_OTP") {
      if (doc.containsKey("otp")) {
        activeOtp = doc["otp"].as<String>();
        isOtpActive = true;
        currentPackageId = doc.containsKey("package") ? doc["package"].as<String>() : "PKG-" + String(random(1000, 9999));
        Serial.print(F("[MQTT] Da cap nhat OTP moi tu Cloud: "));
        Serial.println(activeOtp);
        updateOledUI();
      } else {
        generateNewRandomOtp("MQTT_REMOTE_REQ");
      }
    } else if (cmd == "DELETE_OTP" || cmd == "REVOKE_OTP") {
      deleteCurrentOtp("MQTT_JSON_COMMAND");
    } else if (cmd == "ISOLATE") {
      triggerQuarantine("MQTT_ISOLATE_CMD");
    } else if (cmd == "UNISOLATE") {
      restoreFromQuarantine();
    }
  }
}

void publishMqttEvent(const String& eventType, const String& details) {
  if (!mqttClient.connected()) return;
  StaticJsonDocument<256> doc;
  doc["device_id"] = DEVICE_ID;
  doc["mac"] = deviceMacAddress;
  doc["event"] = eventType;
  doc["details"] = details;
  doc["timestamp"] = millis();

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(MQTT_TOPIC_EVENTS, payload.c_str());
}

void publishMqttStatus() {
  if (!mqttClient.connected()) return;
  StaticJsonDocument<256> doc;
  doc["device_id"] = DEVICE_ID;
  doc["lock_state"] = isUnlocked ? "UNLOCKED" : "LOCKED";
  doc["door_state"] = isDoorOpen ? "OPEN" : "CLOSED";
  doc["package_id"] = currentPackageId;
  doc["otp_active"] = isOtpActive;
  doc["quarantine"] = isQuarantined;

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(MQTT_TOPIC_STATUS, payload.c_str());
}

// =========================================================================
// SINH MÃ OTP NGẪU NHIÊN MỚI (TÁI KÍCH HOẠT)
// =========================================================================
void generateNewRandomOtp(const String& source) {
  // Sinh ngẫu nhiên số có 6 chữ số (100000 -> 999999)
  long randomCode = random(100000, 999999);
  activeOtp = String(randomCode);
  isOtpActive = true;
  currentPackageId = "PKG-" + String(random(1000, 9999));

  Serial.println(F("\n✨ ========================================="));
  Serial.print(F("🎁 [KÍCH HOẠT OTP MỚI] Nguồn: "));
  Serial.println(source);
  Serial.print(F("📦 Mã kiện hàng : "));
  Serial.println(currentPackageId);
  Serial.print(F("🔑 MÃ OTP MỞ TỦ : "));
  Serial.println(activeOtp);
  Serial.println(F("✨ ========================================="));

  playSuccessChime();
  publishMqttEvent("NEW_OTP_GENERATED", "Package: " + currentPackageId + " | OTP: " + activeOtp);
  publishMqttStatus();
  sendAuditLogToDbDirect("DELIVERY", "NEW_OTP_ACTIVATED", "Package " + currentPackageId + " generated new OTP: " + activeOtp);

  updateOledUI();
}

// =========================================================================
// HỦY / XÓA MÃ OTP HIỆN TẠI (REVOKE / DELETE OTP)
// =========================================================================
void deleteCurrentOtp(const String& source) {
  String oldPkg = currentPackageId;
  activeOtp = "";
  isOtpActive = false;
  currentPackageId = "NONE";

  // Âm thanh báo xóa (2 tiếng bíp trầm)
  playTone(800, 150);
  delay(120);
  playTone(500, 250);

  Serial.println(F("\n🗑️ ========================================="));
  Serial.print(F("❌ [ĐÃ XÓA MÃ OTP] Nguồn yêu cầu: "));
  Serial.println(source);
  Serial.print(F("📦 Kiện hàng bị hủy: "));
  Serial.println(oldPkg);
  Serial.println(F("Mã OTP đã bị vô hiệu hóa! Ngăn tủ chuyển về trạng thái TRỐNG."));
  Serial.println(F("🗑️ ========================================="));

  publishMqttEvent("OTP_DELETED", "Active OTP for " + oldPkg + " revoked by " + source);
  publishMqttStatus();
  sendAuditLogToDbDirect("ADMIN", "OTP_REVOKED", "OTP revoked by " + source + " for " + oldPkg);

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(20, 18);
  display.println(F("DA XOA OTP!"));
  display.setCursor(14, 38);
  display.println(F("Ngan tu: TRONG"));
  display.display();
  delay(1500);

  currentState = STATE_IDLE;
  updateOledUI();
}

// =========================================================================
// XỬ LÝ NHẬP PHÍM BÀN PHÍM (KEYPAD)
// =========================================================================
void handleKeyInput(char key) {
  Serial.print(F("[KEYPAD] Phim nhan: "));
  Serial.println(key);

  // Phím C: Xóa ký tự cuối (Backspace) - Hoặc Xóa OTP nếu vừa gõ mã Admin '9999'
  if (key == 'C') {
    if (enteredPin == adminMasterPin) {
      deleteCurrentOtp("KEYPAD_ADMIN_PIN");
      enteredPin = "";
      return;
    }
    if (enteredPin.length() > 0) {
      enteredPin.remove(enteredPin.length() - 1);
    }
    updateOledUI();
    return;
  }

  // Phím *: Hủy / Xóa toàn bộ
  if (key == '*') {
    enteredPin = "";
    currentState = STATE_IDLE;
    updateOledUI();
    return;
  }

  // Phím A: SHIPPER GỬI HÀNG HOẶC SINH MÃ OTP NGẪU NHIÊN MỚI
  if (key == 'A') {
    if (!isOtpActive || currentPackageId == "NONE") {
      // Nếu tủ đang trống / OTP cũ đã bị khóa -> Sinh mã OTP mới!
      generateNewRandomOtp("KEYPAD_A_SHIPPER");
    } else {
      Serial.println(F("[INFO] Tu dang co kien hang va OTP con hieu luc."));
      enteredPin = "";
      currentState = STATE_INPUT_OTP;
      updateOledUI();
    }
    return;
  }

  // Phím B: Cư dân nhận hàng (Nhập OTP)
  if (key == 'B') {
    enteredPin = "";
    currentState = STATE_INPUT_OTP;
    updateOledUI();
    return;
  }

  // Phím D: Menu khẩn cấp / Quản trị
  if (key == 'D') {
    if (enteredPin == adminMasterPin) {
      if (isQuarantined) {
        restoreFromQuarantine();
      } else {
        triggerQuarantine("ADMIN_MANUAL_LOCKDOWN");
      }
      enteredPin = "";
      return;
    }
  }

  // Nhập chữ số (0-9)
  if (key >= '0' && key <= '9') {
    if (enteredPin.length() < 8) {
      enteredPin += key;
      currentState = STATE_INPUT_OTP;
      updateOledUI();
    }
  }

  // Phím #: Xác nhận mở tủ
  if (key == '#') {
    if (enteredPin.length() == 0) return;

    Serial.print(F("[XAC THUC] Dang kiem tra ma: "));
    Serial.println(enteredPin);

    // 1. Kiểm tra Master Admin PIN
    if (enteredPin == adminMasterPin) {
      failedOtpAttempts = 0;
      executeUnlock("ADMIN_PIN", "Master PIN override verified");
      enteredPin = "";
      return;
    }

    // 2. Kiểm tra nếu mã OTP ĐÃ BỊ KHÓA (đã sử dụng trước đó)
    if (!isOtpActive) {
      Serial.println(F("❌ [TU CHOI] Ma OTP nay da bi khoa vi da duoc su dung roi!"));
      playErrorChime();
      display.clearDisplay();
      display.setCursor(0, 15);
      display.setTextSize(1);
      display.println(F("OTP DA BI KHOA!"));
      display.setCursor(0, 32);
      display.println(F("Da su dung roi."));
      display.setCursor(0, 48);
      display.println(F("Bam A de nhan ma moi"));
      display.display();
      delay(2000);
      enteredPin = "";
      currentState = STATE_IDLE;
      updateOledUI();
      return;
    }

    // 3. Kiểm tra Active OTP hợp lệ
    if (enteredPin == activeOtp) {
      failedOtpAttempts = 0;
      executeUnlock("KEYPAD_OTP", "OTP 6 so hop le cho kien " + currentPackageId);
      enteredPin = "";
    } else {
      // Sai mã OTP -> Kích hoạt cơ chế chống Dò mã (Brute Force Anomaly Engine)
      failedOtpAttempts++;
      playErrorChime();
      Serial.print(F("[AN NINH] Ma sai lan: "));
      Serial.println(failedOtpAttempts);

      if (failedOtpAttempts >= 5) {
        lockoutUntil = millis() + 300000;
        sendAuditLogToDbDirect("CRITICAL", "ANOMALY_BRUTE_FORCE_LOCKOUT", "5 failed OTP entries. Keypad locked for 300s.");
        publishMqttEvent("BRUTE_FORCE_ALARM", "5 consecutive failed OTP entries!");
        triggerQuarantine("BRUTE_FORCE_ATTACK_DETECTED");
      } else if (failedOtpAttempts >= 3) {
        lockoutUntil = millis() + 30000;
        sendAuditLogToDbDirect("ANOMALY", "ANOMALY_BRUTE_FORCE_WARN", "3 failed OTP entries. Suspended 30s.");
      }

      enteredPin = "";
      updateOledUI();
    }
  }
}

// =========================================================================
// XỬ LÝ ĐẦU ĐỌC QR CODE (SERIAL2)
// =========================================================================
void handleQrCodeInput() {
  while (Serial2.available()) {
    char c = Serial2.read();
    if (c == '\r' || c == '\n') {
      if (qrInputBuffer.length() > 0) {
        qrInputBuffer.trim();
        Serial.print(F("[QR SCANNER] Nhan: "));
        Serial.println(qrInputBuffer);

        // Chống Injection / Tràn bộ đệm
        if (qrInputBuffer.length() > 32 || qrInputBuffer.indexOf("<") >= 0 || qrInputBuffer.indexOf(";") >= 0) {
          sendAuditLogToDbDirect("ANOMALY", "MALICIOUS_INPUT_PAYLOAD", "Suspicious QR: " + qrInputBuffer);
          playErrorChime();
          qrInputBuffer = "";
          return;
        }

        // Lệnh kích hoạt sinh mã ngẫu nhiên mới qua QR
        if (qrInputBuffer == "CMD:NEW_OTP" || qrInputBuffer == "NEW") {
          generateNewRandomOtp("QR_SCANNER");
          qrInputBuffer = "";
          return;
        }

        // Lệnh xóa / hủy OTP hiện tại qua QR
        if (qrInputBuffer == "CMD:DELETE_OTP" || qrInputBuffer == "DEL" || qrInputBuffer == "DELETE" || qrInputBuffer == "XOA") {
          deleteCurrentOtp("QR_SCANNER");
          qrInputBuffer = "";
          return;
        }

        String extractedCode = qrInputBuffer;
        if (extractedCode.startsWith("OTP:")) {
          extractedCode = extractedCode.substring(4);
        }

        // Kiểm tra OTP bị khóa
        if (!isOtpActive && extractedCode != adminMasterPin) {
          Serial.println(F("❌ [TU CHOI] QR chua OTP da su dung!"));
          playErrorChime();
          qrInputBuffer = "";
          return;
        }

        if (extractedCode == activeOtp || extractedCode == adminMasterPin) {
          failedOtpAttempts = 0;
          executeUnlock("QR_CODE", "Xac thuc QR code thanh cong");
        } else {
          failedOtpAttempts++;
          playErrorChime();
          if (failedOtpAttempts >= 5) {
            triggerQuarantine("BRUTE_FORCE_QR_ATTACK");
          }
        }

        qrInputBuffer = "";
      }
    } else {
      if (qrInputBuffer.length() < 40) {
        qrInputBuffer += c;
      }
    }
  }
}

// =========================================================================
// MỞ / ĐÓNG KHÓA VẬT LÝ & TỰ ĐỘNG KHÓA MÃ OTP
// =========================================================================
void executeUnlock(const String& method, const String& details) {
  if (!breakers.lock_actuator) {
    Serial.println(F("[BREAKER] Nguon Actuator bi ngat! Khong the kich hoat Relay."));
    playErrorChime();
    return;
  }

  isUnlocked = true;
  unlockTimestamp = millis();
  digitalWrite(RELAY_PIN, HIGH); // Kích hoạt Relay mở khóa
  currentState = STATE_UNLOCKED;

  // 🔥 TỰ ĐỘNG KHÓA MÃ OTP NÀY NGAY LẬP TỨC (SINGLE-USE ONLY) 🔥
  isOtpActive = false;
  String finishedPkg = currentPackageId;
  String lockedOtp = activeOtp;
  activeOtp = ""; // Xóa mã cũ

  playSuccessChime();
  Serial.println(F("\n🔒 ==================================================="));
  Serial.println(F("✅ [MỞ KHÓA THÀNH CÔNG] Relay đã nhả chốt 12V!"));
  Serial.print(F("🔒 [KHÓA OTP VĨNH VIỄN] Mã OTP ["));
  Serial.print(lockedOtp);
  Serial.println(F("] ĐÃ BỊ VÔ HIỆU HÓA, KHÔNG THỂ DÙNG LẠI!"));
  Serial.println(F("🔒 ==================================================="));

  // Gửi sự kiện lên MQTT RabbitMQ
  publishMqttEvent("OTP_CLAIMED_AND_LOCKED", "Package " + finishedPkg + " received with OTP. OTP is now expired.");
  publishMqttStatus();

  // Ghi nhật ký trực tiếp vào CSDL
  sendAuditLogToDbDirect("ACCESS", "LOCKER_UNLOCKED_OTP_EXPIRED", "Method: " + method + " | Package: " + finishedPkg);

  updateOledUI();
}

void executeLock() {
  isUnlocked = false;
  digitalWrite(RELAY_PIN, LOW); // Đóng chốt
  currentState = STATE_IDLE;
  Serial.println(F("[ACTUATOR] Da khoa chot tu dong an toan."));

  publishMqttStatus();
  sendAuditLogToDbDirect("ACCESS", "LOCKER_LOCKED", "Locker secured and locked.");
  updateOledUI();
}

// =========================================================================
// KIỂM TOÁN AN NINH LIÊN TỤC & PHÁT HIỆN DỊ THƯỜNG
// =========================================================================
void checkSensorsAndAnomalies() {
  unsigned long now = millis();
  bool rawDoorState = (digitalRead(DOOR_PIN) == HIGH);

  // 1. Dị thường cạy cửa trái phép (Tamper)
  if (rawDoorState && !lastDoorState) {
    doorOpenCount++;
    if (!isUnlocked) {
      isBreakInDetected = true;
      Serial.println(F("🚨 [CANH BAO AN NINH] PHAT HIEN CAY CUA TRAI PHEP (TAMPER)!"));
      playAlarmSiren();

      publishMqttEvent("TAMPER_ALARM", "Physical door breach detected without unlock command!");
      sendAuditLogToDbDirect("CRITICAL", "ANOMALY_PHYSICAL_BREAK_IN", "Door forced open! Siren triggered.");
      triggerQuarantine("PHYSICAL_BREAK_IN_TAMPER");
    } else {
      Serial.println(F("[SENSOR] Cu dan da mo cua lay hang."));
      doorOpenedTimestamp = now;
      isDoorAjarAlerted = false;
    }
  }

  // Khi cửa đóng lại sau khi mở
  if (!rawDoorState && lastDoorState) {
    Serial.println(F("[SENSOR] Cua tu da dong hoan toan."));
    if (isUnlocked) {
      executeLock();
    }
  }

  // 2. Dị thường cửa quên đóng
  if (rawDoorState) {
    if (now - doorOpenedTimestamp > 30000 && !isDoorAjarAlerted) {
      playTone(1800, 100);
      if (now - doorOpenedTimestamp > 60000) {
        isDoorAjarAlerted = true;
        publishMqttEvent("DOOR_AJAR_WARNING", "Door open > 60s");
        sendAuditLogToDbDirect("ANOMALY", "ANOMALY_DOOR_AJAR", "Door open > 60s.");
      }
    }
  }

  lastDoorState = rawDoorState;
  isDoorOpen = rawDoorState;
}

// =========================================================================
// CÁCH LY KHẨN CẤP
// =========================================================================
void triggerQuarantine(const String& reason) {
  isQuarantined = true;
  currentState = STATE_QUARANTINED;
  digitalWrite(RELAY_PIN, LOW);

  Serial.print(F("⛔ [CACH LY] THIET BI BI KHOA AN NINH! Ly do: "));
  Serial.println(reason);

  playAlarmSiren();
  publishMqttEvent("QUARANTINE_LOCKED", reason);
  sendAuditLogToDbDirect("CRITICAL", "SYSTEM_QUARANTINED", reason);
  updateOledUI();
}

void restoreFromQuarantine() {
  isQuarantined = false;
  isBreakInDetected = false;
  failedOtpAttempts = 0;
  currentState = STATE_IDLE;

  Serial.println(F("✅ [PHUC HOI] Go bo cach ly an ninh."));
  playSuccessChime();
  publishMqttEvent("QUARANTINE_RESTORED", "Admin cleared quarantine");
  sendAuditLogToDbDirect("SECURITY", "SYSTEM_RESTORED", "Quarantine cleared.");
  updateOledUI();
}

// =========================================================================
// HIỂN THỊ OLED TRỰC QUAN
// =========================================================================
void updateOledUI() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  if (isQuarantined) {
    display.setTextSize(1);
    display.setCursor(16, 2);
    display.println(F("! CANH BAO !"));
    display.drawLine(0, 12, 127, 12, SSD1306_WHITE);

    display.setTextSize(2);
    display.setCursor(4, 20);
    display.println(F("CACH LY!"));

    display.setTextSize(1);
    display.setCursor(0, 42);
    display.println(F("Nguy co an ninh"));
    display.setCursor(0, 53);
    display.println(F("Lien he BQL toa nha"));
    display.display();
    return;
  }

  if (currentState == STATE_UNLOCKED) {
    display.setTextSize(1);
    display.setCursor(14, 2);
    display.println(F("SMART LOCKER"));
    display.drawLine(0, 12, 127, 12, SSD1306_WHITE);

    display.setTextSize(2);
    display.setCursor(12, 22);
    display.println(F("DA MO CUA"));

    display.setTextSize(1);
    display.setCursor(8, 48);
    display.println(F("Vui long dong cua!"));
    display.display();
    return;
  }

  if (currentState == STATE_INPUT_OTP) {
    display.setTextSize(1);
    display.setCursor(10, 2);
    display.println(F("NHAP MA OTP / PIN"));
    display.drawLine(0, 12, 127, 12, SSD1306_WHITE);

    display.setTextSize(2);
    display.setCursor(20, 22);
    String masked = "";
    for (size_t i = 0; i < enteredPin.length(); i++) masked += "*";
    if (masked.length() == 0) masked = "_";
    display.println(masked);

    display.setTextSize(1);
    display.setCursor(0, 48);
    display.println(F("[#] Xac nhan  [*] Huy"));
    display.display();
    return;
  }

  // STATE_IDLE Mặc định
  display.setTextSize(1);
  display.setCursor(12, 2);
  display.println(F("SMART LOCKER N6"));
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  // Trạng thái ngăn & mã OTP
  display.setCursor(0, 16);
  if (isOtpActive) {
    display.print(F("OTP: KICH HOAT ("));
    display.print(currentPackageId);
    display.print(F(")"));
  } else {
    display.print(F("OTP: DA KHOA (Het han)"));
  }

  display.setCursor(0, 28);
  display.print(F("Khoa: "));
  display.print(isUnlocked ? "MO CHOT" : "DANG KHOA");

  display.setCursor(0, 40);
  display.print(F("Cua : "));
  display.print(isDoorOpen ? "DANG MO" : "DA DONG");

  display.drawLine(0, 52, 127, 52, SSD1306_WHITE);
  display.setCursor(0, 55);
  if (isOtpActive) {
    display.print(F("Bam B nhan | A gui"));
  } else {
    display.print(F("Bam A: Tao OTP ngau nhien"));
  }

  display.display();
}

// =========================================================================
// ĐỒNG BỘ DEVICE SHADOW & ĐO LƯỜNG LŨY TUYẾN (EXPONENTIAL BACKOFF)
// =========================================================================
void syncDeviceShadowAndTelemetry() {
  if (WiFi.status() != WL_CONNECTED) {
    consecutiveErrors++;
    consecutiveSuccesses = 0;
    syncIntervalMs = min(syncIntervalMs * 2, MAX_SYNC_INTERVAL);
    Serial.print(F("⚠️ [LUY TUYEN] Mat mang! Tang chu ky len: "));
    Serial.print(syncIntervalMs);
    Serial.println(F(" ms"));
    return;
  }

  // Đẩy Telemetry qua MQTT RabbitMQ nếu đang kết nối
  if (mqttClient.connected()) {
    StaticJsonDocument<256> mqttDoc;
    mqttDoc["rssi"] = WiFi.RSSI();
    mqttDoc["free_heap"] = ESP.getFreeHeap();
    mqttDoc["uptime"] = millis() / 1000;
    mqttDoc["sync_rate"] = syncIntervalMs;
    String mqttPayload;
    serializeJson(mqttDoc, mqttPayload);
    mqttClient.publish(MQTT_TOPIC_TELEMETRY, mqttPayload.c_str());
  }

  HTTPClient http;
  String shadowUrl = String(SERVER_BASE_URL) + "/api/v1/shadow";
  http.begin(shadowUrl);
  http.setTimeout(1500);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-MAC", deviceMacAddress);
  http.addHeader("X-Device-ID", DEVICE_ID);

  StaticJsonDocument<512> doc;
  doc["lock_state"] = isUnlocked ? "UNLOCKED" : "LOCKED";
  doc["door_state"] = isDoorOpen ? "OPEN" : "CLOSED";
  doc["quarantine_mode"] = isQuarantined;
  doc["sync_interval_ms"] = syncIntervalMs;
  doc["otp_active"] = isOtpActive;

  if (syncIntervalMs == MIN_SYNC_INTERVAL) {
    doc["locker_status"] = isOtpActive ? "OCCUPIED" : "AVAILABLE";
    doc["package_id"] = currentPackageId;
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["free_heap"] = ESP.getFreeHeap();
    doc["uptime_sec"] = millis() / 1000;
    doc["door_open_count"] = doorOpenCount;
  } else {
    // Lũy tuyến: Đồng bộ ngẫu nhiên cảm biến
    int choice = random(0, 3);
    if (choice == 0) doc["wifi_rssi"] = WiFi.RSSI();
    else if (choice == 1) doc["free_heap"] = ESP.getFreeHeap();
    else doc["door_open_count"] = doorOpenCount;
  }

  String requestBody;
  serializeJson(doc, requestBody);
  int httpCode = http.POST(requestBody);

  if (httpCode == HTTP_CODE_OK) {
    consecutiveSuccesses++;
    consecutiveErrors = 0;
    if (consecutiveSuccesses >= 2 && syncIntervalMs > MIN_SYNC_INTERVAL) {
      syncIntervalMs = max(MIN_SYNC_INTERVAL, syncIntervalMs / 2);
    }

    String response = http.getString();
    StaticJsonDocument<512> respDoc;
    if (!deserializeJson(respDoc, response)) {
      if (respDoc.containsKey("desired")) {
        JsonObject desired = respDoc["desired"];
        if (desired.containsKey("command")) {
          String cmd = desired["command"].as<String>();
          if (cmd == "UNLOCK" && !isUnlocked) {
            executeUnlock("REMOTE_SHADOW", "Remote unlock");
          } else if (cmd == "GENERATE_OTP") {
            generateNewRandomOtp("CLOUD_DESIRED");
          } else if (cmd == "DELETE_OTP" || cmd == "REVOKE_OTP") {
            deleteCurrentOtp("CLOUD_DESIRED");
          }
        }
      }
    }
  } else {
    consecutiveErrors++;
    consecutiveSuccesses = 0;
    syncIntervalMs = min(syncIntervalMs * 2, MAX_SYNC_INTERVAL);
  }
  http.end();
}

// =========================================================================
// GỬI NHẬT KÝ KIỂM TOÁN TRỰC TIẾP LÊN DB
// =========================================================================
void sendAuditLogToDbDirect(const String& level, const String& event, const String& details) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String auditUrl = String(SERVER_BASE_URL) + "/api/v1/audit/logs";
  http.begin(auditUrl);
  http.setTimeout(1000);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["level"] = level;
  doc["source"] = "ESP32_EDGE";
  doc["event"] = event;
  doc["details"] = details;
  doc["mac"] = deviceMacAddress;
  doc["deviceId"] = DEVICE_ID;

  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}