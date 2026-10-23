#include "ui.h"
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "config.h"

static Adafruit_SSD1306 display(128, 64, &Wire, -1);
static bool ready = false;

static Screen lastScreen = (Screen)-1;
static int lastNumber = -999;
static bool lastOnline = false;

void uiBegin() {
  Wire.begin(21, 22);
  ready = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!ready) {
    Serial.println(F("[OLED] Khong tim thay man hinh"));
    return;
  }
  display.setTextColor(SSD1306_WHITE);
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(16, 28);
  display.print(F("Dang khoi dong..."));
  display.display();
}

static void header(bool online) {
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("SMART LOCKER"));
  display.setCursor(86, 0);
  display.print(online ? F("ONLINE") : F("OFFLN"));
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);
}

static void centered(const char* text, int y, uint8_t size) {
  int16_t x1, y1;
  uint16_t w, h;
  display.setTextSize(size);
  display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  display.setCursor((128 - w) / 2, y);
  display.print(text);
}

static void otpBoxes(int filled) {
  const int box = 14, gap = 5;
  const int startX = (128 - (OTP_LENGTH * box + (OTP_LENGTH - 1) * gap)) / 2;
  for (int i = 0; i < OTP_LENGTH; i++) {
    int x = startX + i * (box + gap);
    if (i < filled) display.fillRect(x, 30, box, box, SSD1306_WHITE);
    else display.drawRect(x, 30, box, box, SSD1306_WHITE);
  }
}

void uiDraw(Screen s, int number, bool online) {
  if (!ready) return;
  if (s == lastScreen && number == lastNumber && online == lastOnline) return;
  lastScreen = s;
  lastNumber = number;
  lastOnline = online;

  char line[24];
  display.clearDisplay();
  header(online);

  switch (s) {
    case SCR_IDLE:
      centered("Nhap ma OTP", 20, 1);
      otpBoxes(0);
      centered(online ? "# xac nhan  * xoa" : "Dang ket noi...", 54, 1);
      break;
    case SCR_INPUT:
      centered("Nhap ma OTP", 16, 1);
      otpBoxes(number);
      centered(number == OTP_LENGTH ? "Bam # de xac nhan" : "*:xoa 1  D:xoa het", 54, 1);
      break;
    case SCR_WAITING:
      centered("Dang xac thuc...", 30, 1);
      break;
    case SCR_UNLOCKED:
      centered("MOI MO CUA", 20, 2);
      if (number >= 0) snprintf(line, sizeof(line), "Tu khoa sau %ds", number);
      else snprintf(line, sizeof(line), "Dong cua de khoa");
      centered(line, 48, 1);
      break;
    case SCR_DENIED:
      centered("SAI MA!", 20, 2);
      if (number >= 0) {
        snprintf(line, sizeof(line), "Con %d lan thu", number);
        centered(line, 48, 1);
      }
      break;
    case SCR_NO_OTP:
      centered("Chua co ma OTP", 26, 1);
      centered("Lien he quan tri", 42, 1);
      break;
    case SCR_LOCKOUT:
      centered("TAM KHOA", 18, 2);
      snprintf(line, sizeof(line), "Thu lai sau %d:%02d", number / 60, number % 60);
      centered(line, 46, 1);
      break;
    case SCR_OFFLINE:
      centered("Mat ket noi", 22, 1);
      centered("may chu!", 36, 1);
      centered("Khong the xac thuc", 52, 1);
      break;
    case SCR_TAMPER:
      centered("CANH BAO!", 18, 2);
      centered("Cua bi mo trai phep", 46, 1);
      break;
  }
  display.display();
}
