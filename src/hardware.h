#pragma once
#include <Arduino.h>

// Relay khóa, cảm biến cửa, còi, LED trạng thái. Mọi hàm đều không chặn.

enum Sound { SND_KEY, SND_OK, SND_ERROR, SND_ALARM };

void hwBegin();
void hwSetRelay(bool open);   // true = nhả chốt
bool hwDoorOpen();            // true = cửa đang mở
void hwPlay(Sound s);         // phát chuỗi âm, không chặn
void hwSetLedFast(bool fast); // nháy nhanh khi mất kết nối
void hwUpdate();              // gọi mỗi vòng loop()
