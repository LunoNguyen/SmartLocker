#ifndef CONFIG_H
#define CONFIG_H

/* =========================================================================
 * CẤU HÌNH SMART LOCKER - NHÓM 6
 * ESP32 KHÔNG giữ mã OTP. Mã do web quản lý; ESP32 gửi mã người dùng nhập
 * lên MQTT (topic verify) và chờ web trả kết quả (topic verify/result).
 * ========================================================================= */

// --- WiFi (Wokwi) ---
#define WIFI_SSID           "Wokwi-GUEST"
#define WIFI_PASS           ""

// --- MQTT broker: Mosquitto trên VMware Ubuntu ---
// Lấy IP bằng `ip a` trên Ubuntu (card ens33). Wokwi đi ra mạng qua máy Windows,
// nên Windows ping được IP này là ESP32 kết nối được.
#define MQTT_BROKER_HOST    "192.168.209.128"
#define MQTT_BROKER_PORT    1883
#define MQTT_USERNAME       "gateway_admin"
#define MQTT_PASSWORD       "123456"
#define MQTT_CLIENT_ID      "SmartLocker_01"

// --- Topic (phải khớp server/src/mqttBridge.js) ---
#define TOPIC_PREFIX        "smartlocker/locker1/"
#define TOPIC_VERIFY        TOPIC_PREFIX "verify"         // ESP32 -> web: {"req","code"}
#define TOPIC_RESULT        TOPIC_PREFIX "verify/result"  // web -> ESP32: {"req","ok",...}
#define TOPIC_COMMAND       TOPIC_PREFIX "command"        // web -> ESP32: {"cmd":"UNLOCK"}
#define TOPIC_STATUS        TOPIC_PREFIX "status"         // ESP32 -> web (retained + Last Will)
#define TOPIC_EVENTS        TOPIC_PREFIX "events"         // ESP32 -> web

// --- Thời gian (ms) ---
#define VERIFY_TIMEOUT_MS   5000   // chờ web trả kết quả
#define UNLOCK_DURATION_MS  6000   // tự khóa nếu không mở cửa
#define MESSAGE_SHOW_MS     3000   // thời gian hiện thông báo lỗi trên OLED
#define MQTT_RETRY_MS       5000   // khoảng cách giữa các lần thử kết nối lại

// --- Mã OTP ---
#define OTP_LENGTH          6

#endif // CONFIG_H
