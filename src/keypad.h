#pragma once
#include <Arduino.h>

// Bàn phím ma trận 4x4, quét không chặn.

void keypadBegin();
char keypadGetKey();  // trả ký tự phím vừa nhấn, 0 nếu không có phím mới
