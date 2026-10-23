#include "keypad.h"

static const uint8_t ROWS = 4;
static const uint8_t COLS = 4;
static const uint8_t rowPins[ROWS] = {13, 12, 14, 27};
static const uint8_t colPins[COLS] = {26, 25, 33, 32};
static const char keyMap[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};

static const unsigned long DEBOUNCE_MS = 30;

static char candidate = 0;          // phím đang được giữ ở lần quét trước
static unsigned long candidateSince = 0;
static bool reported = false;       // đã trả phím này chưa (chỉ trả 1 lần cho tới khi nhả)

void keypadBegin() {
  for (uint8_t r = 0; r < ROWS; r++) {
    pinMode(rowPins[r], OUTPUT);
    digitalWrite(rowPins[r], HIGH);
  }
  for (uint8_t c = 0; c < COLS; c++) {
    pinMode(colPins[c], INPUT_PULLUP);
  }
}

static char scanOnce() {
  char found = 0;
  for (uint8_t r = 0; r < ROWS && !found; r++) {
    digitalWrite(rowPins[r], LOW);
    delayMicroseconds(5);  // cho điện áp cột ổn định
    for (uint8_t c = 0; c < COLS; c++) {
      if (digitalRead(colPins[c]) == LOW) {
        found = keyMap[r][c];
        break;
      }
    }
    digitalWrite(rowPins[r], HIGH);
  }
  return found;
}

char keypadGetKey() {
  char k = scanOnce();
  unsigned long now = millis();

  if (k != candidate) {
    candidate = k;
    candidateSince = now;
    reported = false;
    return 0;
  }
  if (k && !reported && now - candidateSince >= DEBOUNCE_MS) {
    reported = true;
    return k;
  }
  return 0;
}
