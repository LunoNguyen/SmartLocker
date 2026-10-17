#ifndef CONFIG_H
#define CONFIG_H

/* =========================================================================
 * BẢNG CẤU HÌNH HỆ THỐNG SMART LOCKER (DỄ DÀNG THAY ĐỔI)
 * ========================================================================= */

// --- CẤU HÌNH KẾT NỐI WIFI ---
#define WIFI_SSID           "Wokwi-GUEST"
#define WIFI_PASS           ""

// --- CẤU HÌNH MQTT BROKER (MOSQUITTO LOCAL TRÊN MÁY ẢO UBUNTU) ---
// Wokwi chạy trên Windows, ESP32 mô phỏng đi ra mạng qua Private Gateway của Wokwi
// (tức là đi qua chính máy Windows), nên chỉ cần Windows kết nối được tới broker là ESP32 kết nối được.
//
// Chọn 1 trong 2 cách (xem mosquitto/README.md):
//  - Cách A (khuyên dùng): VM dùng card mạng Bridged / Host-only
//      -> đặt MQTT_BROKER_HOST = IP của VM (lệnh `hostname -I` trên Ubuntu), VD "192.168.56.101"
//  - Cách B: VM dùng NAT + Port Forwarding 1883 (host) -> 1883 (guest)
//      -> đặt MQTT_BROKER_HOST = "host.wokwi.internal" (= localhost của máy Windows)
#define MQTT_BROKER_HOST    "192.168.209.128" // IP máy ảo Ubuntu chạy Mosquitto (ĐỔI LẠI CHO ĐÚNG)
#define MQTT_BROKER_PORT    1883             // Cổng MQTT tiêu chuẩn của Mosquitto
#define MQTT_USERNAME       "gateway_admin"  // Tài khoản Mosquitto (mosquitto_passwd)
#define MQTT_PASSWORD       "123456"         // Mật khẩu Mosquitto
#define MQTT_CLIENT_ID      "SmartLocker_01" // Client ID định danh thiết bị

// Các Topics MQTT chuẩn hóa của Smart Locker
#define MQTT_TOPIC_COMMAND    "smartlocker/locker1/command"   // Nhận lệnh từ Broker (UNLOCK, NEW_OTP, ISOLATE)
#define MQTT_TOPIC_STATUS     "smartlocker/locker1/status"    // Báo cáo trạng thái Khóa, Cửa, Ngăn
#define MQTT_TOPIC_TELEMETRY  "smartlocker/locker1/telemetry" // Báo cáo thông số cảm biến theo chu kỳ lũy tuyến
#define MQTT_TOPIC_EVENTS     "smartlocker/locker1/events"    // Báo cáo sự kiện nhận hàng, dị thường cạy cửa

// --- CẤU HÌNH MÁY CHỦ HTTP REST / DATABASE BACKEND ---
// Server Node.js (server/server.js) chạy trên Windows; trong Wokwi "host.wokwi.internal" = localhost của Windows
#define SERVER_BASE_URL     "http://host.wokwi.internal:5000"
#define DEVICE_ID           "SMART_LOCKER_01"

// --- THỜI GIAN MỞ KHÓA TỰ ĐỘNG ---
#define UNLOCK_DURATION_MS  6000  // Tự động đóng chốt sau 6 giây nếu không mở cửa

#endif // CONFIG_H
