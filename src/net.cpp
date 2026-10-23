#include "net.h"
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "config.h"

static WiFiClient wifiClient;
static PubSubClient mqtt(wifiClient);

static void (*resultHandler)(const VerifyResult&) = nullptr;
static void (*unlockHandler)() = nullptr;

static unsigned long lastAttempt = 0;
static bool lastUnlocked = false;
static bool lastDoorOpen = false;
static bool wifiAnnounced = false;

static void onMessage(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, payload, length)) {
    Serial.printf("[MQTT] Bo qua payload khong hop le tren %s\n", topic);
    return;
  }

  if (strcmp(topic, TOPIC_RESULT) == 0) {
    VerifyResult r = {};
    strlcpy(r.req, doc["req"] | "", sizeof(r.req));
    r.ok = doc["ok"] | false;
    strlcpy(r.reason, doc["reason"] | "", sizeof(r.reason));
    r.attemptsLeft = doc["attempts_left"] | -1;
    r.retryIn = doc["retry_in"] | -1;
    Serial.printf("[MQTT] Ket qua req=%s ok=%d reason=%s\n", r.req, r.ok, r.reason);
    if (resultHandler) resultHandler(r);
  } else if (strcmp(topic, TOPIC_COMMAND) == 0) {
    const char* cmd = doc["cmd"] | "";
    Serial.printf("[MQTT] Lenh: %s\n", cmd);
    if (strcmp(cmd, "UNLOCK") == 0 && unlockHandler) unlockHandler();
  }
}

static void publishStatusNow() {
  StaticJsonDocument<128> doc;
  doc["online"] = true;
  doc["lock"] = lastUnlocked ? "UNLOCKED" : "LOCKED";
  doc["door"] = lastDoorOpen ? "OPEN" : "CLOSED";
  char buf[128];
  size_t n = serializeJson(doc, buf);
  mqtt.publish(TOPIC_STATUS, (const uint8_t*)buf, n, true);
}

static void tryConnect() {
  Serial.printf("[MQTT] Ket noi %s:%d ...\n", MQTT_BROKER_HOST, MQTT_BROKER_PORT);
  if (mqtt.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD,
                   TOPIC_STATUS, 0, true, "{\"online\":false}")) {
    Serial.println(F("[MQTT] Da ket noi broker"));
    mqtt.subscribe(TOPIC_RESULT);
    mqtt.subscribe(TOPIC_COMMAND);
    publishStatusNow();
    return;
  }
  int rc = mqtt.state();
  const char* why = rc == -2 ? "khong mo duoc TCP (sai IP, VM tat, firewall?)"
                  : rc == -4 ? "timeout"
                  : rc == 4  ? "sai username/password"
                  : rc == 5  ? "khong duoc phep"
                  : "";
  Serial.printf("[MQTT] That bai rc=%d %s\n", rc, why);
}

void netBegin(void (*onResult)(const VerifyResult&), void (*onUnlockCmd)()) {
  resultHandler = onResult;
  unlockHandler = onUnlockCmd;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);  // kênh 6 giúp Wokwi kết nối nhanh hơn

  IPAddress ip;
  if (ip.fromString(MQTT_BROKER_HOST)) mqtt.setServer(ip, MQTT_BROKER_PORT);
  else mqtt.setServer(MQTT_BROKER_HOST, MQTT_BROKER_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setSocketTimeout(2);
  mqtt.setKeepAlive(10);
  wifiClient.setTimeout(1);  // giới hạn thời gian connect TCP, tránh treo loop()
}

void netLoop() {
  if (WiFi.status() != WL_CONNECTED) {
    wifiAnnounced = false;
    return;
  }
  if (!wifiAnnounced) {
    wifiAnnounced = true;
    Serial.print(F("[WIFI] Da ket noi, IP: "));
    Serial.println(WiFi.localIP());
    lastAttempt = millis() - MQTT_RETRY_MS;  // thử MQTT ngay
  }

  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }
  if (millis() - lastAttempt >= MQTT_RETRY_MS) {
    lastAttempt = millis();
    tryConnect();
  }
}

bool netConnected() {
  return mqtt.connected();
}

bool netSendVerify(const char* req, const char* code) {
  if (!mqtt.connected()) return false;
  StaticJsonDocument<96> doc;
  doc["req"] = req;
  doc["code"] = code;
  char buf[96];
  size_t n = serializeJson(doc, buf);
  Serial.printf("[MQTT] Gui yeu cau xac thuc req=%s\n", req);  // không in mã
  return mqtt.publish(TOPIC_VERIFY, (const uint8_t*)buf, n, false);
}

void netPublishStatus(bool unlocked, bool doorOpen) {
  lastUnlocked = unlocked;
  lastDoorOpen = doorOpen;
  if (mqtt.connected()) publishStatusNow();
}

void netPublishEvent(const char* event, const char* source) {
  if (!mqtt.connected()) return;
  StaticJsonDocument<96> doc;
  doc["event"] = event;
  doc["source"] = source;
  char buf[96];
  size_t n = serializeJson(doc, buf);
  mqtt.publish(TOPIC_EVENTS, (const uint8_t*)buf, n, false);
}
