#ifndef CONFIG_H
#define CONFIG_H

/* =========================================================================
 * BẢNG CẤU HÌNH HỆ THỐNG SMART LOCKER (DỄ DÀNG THAY ĐỔI)
 * ========================================================================= */

// --- CẤU HÌNH KẾT NỐI WIFI ---
#define WIFI_SSID           "Wokwi-GUEST"
#define WIFI_PASS           ""

// --- CẤU HÌNH MQTT BROKER (RABBITMQ / LOCAL BROKER) ---
// Thay đổi IP máy chủ RabbitMQ ở đây khi triển khai thực tế (VD: 192.168.1.50 hoặc localhost)
// Trong Wokwi Simulator, "10.0.2.2" đại diện cho localhost của máy tính chạy mô phỏng.
#define MQTT_BROKER_HOST    "10.0.2.2"       // IP máy tính chạy RabbitMQ (hoặc broker IP)
#define MQTT_BROKER_PORT    1883             // Cổng MQTT tiêu chuẩn của RabbitMQ
#define MQTT_USERNAME       "luno"           // Tài khoản RabbitMQ
#define MQTT_PASSWORD       "luno"           // Mật khẩu RabbitMQ
#define MQTT_CLIENT_ID      "SmartLocker_01" // Client ID định danh thiết bị

// Các Topics MQTT chuẩn hóa của Smart Locker
#define MQTT_TOPIC_COMMAND    "smartlocker/locker1/command"   // Nhận lệnh từ RabbitMQ (UNLOCK, NEW_OTP, ISOLATE)
#define MQTT_TOPIC_STATUS     "smartlocker/locker1/status"    // Báo cáo trạng thái Khóa, Cửa, Ngăn
#define MQTT_TOPIC_TELEMETRY  "smartlocker/locker1/telemetry" // Báo cáo thông số cảm biến theo chu kỳ lũy tuyến
#define MQTT_TOPIC_EVENTS     "smartlocker/locker1/events"    // Báo cáo sự kiện nhận hàng, dị thường cạy cửa

// --- CẤU HÌNH MÁY CHỦ HTTP REST / DATABASE BACKEND ---
#define SERVER_BASE_URL     "http://10.0.2.2:5000"
#define DEVICE_ID           "SMART_LOCKER_01"

// --- THỜI GIAN MỞ KHÓA TỰ ĐỘNG ---
#define UNLOCK_DURATION_MS  6000  // Tự động đóng chốt sau 6 giây nếu không mở cửa

#endif // CONFIG_H
