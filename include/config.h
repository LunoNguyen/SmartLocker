#ifndef CONFIG_H
#define CONFIG_H

/* =========================================================================
 * BẢNG CẤU HÌNH HỆ THỐNG SMART LOCKER (DỄ DÀNG THAY ĐỔI)
 * ========================================================================= */

// --- CẤU HÌNH KẾT NỐI WIFI ---
#define WIFI_SSID           "Wokwi-GUEST"
#define WIFI_PASS           ""

// --- CẤU HÌNH MQTT BROKER (MOSQUITTO LOCAL) ---
// Chọn 1 trong 2 môi trường bên dưới:
// #define RUN_ON_DOCKER_WINDOWS     // BẬT dòng này nếu chạy Docker trên Windows (Không cần máy ảo)
#define RUN_ON_VMWARE_UBUNTU   // BẬT dòng này nếu chạy Mosquitto trên máy ảo Ubuntu

#if defined(RUN_ON_DOCKER_WINDOWS)
  #define MQTT_BROKER_HOST    "host.wokwi.internal" // Tự động trỏ về Windows/Docker, không lo đổi IP
#elif defined(RUN_ON_VMWARE_UBUNTU)
  #define MQTT_BROKER_HOST    "192.168.209.128"     // IP máy ảo Ubuntu của bạn bạn
#else
  #define MQTT_BROKER_HOST    "host.wokwi.internal"
#endif

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
#define UNLOCK_DURATION_MS        6000   // Tự động đóng chốt sau 6 giây nếu không mở cửa

// --- CẤU HÌNH TỦ CÁ NHÂN (1 NGƯỜI DÙNG) & BỎ LŨY TUYẾN BĂNG THÔNG ---
#define OTP_ROTATION_INTERVAL_MS  300000 // Tự động đổi mã OTP ngẫu nhiên mỗi 5 phút (300s = 300,000ms)
#define TELEMETRY_INTERVAL_MS     5000   // Chu kỳ gửi dữ liệu định kỳ cố định 5 giây (Đã bỏ lũy tuyến)

#endif // CONFIG_H
