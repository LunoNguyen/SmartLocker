#pragma once
#include <Arduino.h>

// Màn hình OLED SSD1306 128x64. Chỉ vẽ lại khi nội dung đổi.

enum Screen {
  SCR_IDLE,       // "Nhap ma OTP"
  SCR_INPUT,      // ô nhập che số; number = số chữ số đã nhập
  SCR_WAITING,    // "Dang xac thuc..."
  SCR_UNLOCKED,   // "Moi mo cua"; number = giây còn lại (-1 = đang chờ đóng cửa)
  SCR_DENIED,     // "Sai ma"; number = attempts_left
  SCR_NO_OTP,     // "Chua co ma OTP"
  SCR_LOCKOUT,    // "Tam khoa"; number = giây còn lại
  SCR_OFFLINE,    // "Mat ket noi may chu"
  SCR_TAMPER      // cảnh báo cạy cửa
};

void uiBegin();
void uiDraw(Screen s, int number, bool online);
