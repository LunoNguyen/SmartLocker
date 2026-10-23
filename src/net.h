#pragma once
#include <Arduino.h>

// WiFi + MQTT không chặn. Mọi giao tiếp với web đều đi qua đây.

struct VerifyResult {
  char req[9];
  bool ok;
  char reason[12];    // "WRONG" | "LOCKED_OUT" | "NO_OTP" | "" khi ok
  int attemptsLeft;   // -1 nếu không có
  int retryIn;        // giây, -1 nếu không có
};

void netBegin(void (*onResult)(const VerifyResult&), void (*onUnlockCmd)());
void netLoop();
bool netConnected();
bool netSendVerify(const char* req, const char* code);
void netPublishStatus(bool unlocked, bool doorOpen);  // retained
void netPublishEvent(const char* event, const char* source);
