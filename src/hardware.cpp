#include "hardware.h"

#define RELAY_PIN   23  // HIGH = mở chốt
#define DOOR_PIN    18  // INPUT_PULLUP: LOW = đóng, HIGH = mở
#define BUZZER_PIN  15
#define LED_PIN     2

struct Note { uint16_t freq; uint16_t ms; };  // freq 0 = nghỉ

static const Note TUNE_KEY[]   = {{2200, 30}};
static const Note TUNE_OK[]    = {{1500, 100}, {0, 40}, {2000, 160}};
static const Note TUNE_ERROR[] = {{400, 450}};
static const Note TUNE_ALARM[] = {{2500, 250}, {1500, 250}, {2500, 250}, {1500, 250}, {2500, 250}, {1500, 250},
                                  {2500, 250}, {1500, 250}, {2500, 250}, {1500, 250}, {2500, 250}, {1500, 250}};

static const Note* tune = nullptr;
static uint8_t tuneLen = 0;
static uint8_t tuneIdx = 0;
static unsigned long noteEndsAt = 0;

static bool ledFast = false;
static bool ledOn = false;
static unsigned long ledToggledAt = 0;

void hwBegin() {
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  pinMode(DOOR_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
}

void hwSetRelay(bool open) {
  digitalWrite(RELAY_PIN, open ? HIGH : LOW);
}

bool hwDoorOpen() {
  return digitalRead(DOOR_PIN) == HIGH;
}

void hwPlay(Sound s) {
  switch (s) {
    case SND_KEY:   tune = TUNE_KEY;   tuneLen = sizeof(TUNE_KEY) / sizeof(Note); break;
    case SND_OK:    tune = TUNE_OK;    tuneLen = sizeof(TUNE_OK) / sizeof(Note); break;
    case SND_ERROR: tune = TUNE_ERROR; tuneLen = sizeof(TUNE_ERROR) / sizeof(Note); break;
    case SND_ALARM: tune = TUNE_ALARM; tuneLen = sizeof(TUNE_ALARM) / sizeof(Note); break;
  }
  tuneIdx = 0;
  noteEndsAt = 0;  // phát nốt đầu ngay ở hwUpdate kế tiếp
}

void hwSetLedFast(bool fast) {
  ledFast = fast;
}

static void updateTune(unsigned long now) {
  if (!tune || now < noteEndsAt) return;
  if (tuneIdx >= tuneLen) {
    noTone(BUZZER_PIN);
    tune = nullptr;
    return;
  }
  const Note& n = tune[tuneIdx++];
  if (n.freq) tone(BUZZER_PIN, n.freq, n.ms);
  else noTone(BUZZER_PIN);
  noteEndsAt = now + n.ms;
}

void hwUpdate() {
  unsigned long now = millis();
  updateTune(now);

  unsigned long period = ledFast ? 150 : 800;
  if (now - ledToggledAt >= period) {
    ledToggledAt = now;
    ledOn = !ledOn;
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
  }
}
