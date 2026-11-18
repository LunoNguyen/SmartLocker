// Đọc cấu hình kết nối MQTT từ biến môi trường (dùng chung cho server và tools/fake-locker.js).
// Mặc định mqtt:// (cổng 1883). Đổi MQTT_URL sang mqtts://IP:8883 + MQTT_CA_FILE để bật MQTT over TLS.

const fs = require('fs');
const path = require('path');

function buildMqttOptions(env, baseDir) {
  const url = env.MQTT_URL || 'mqtt://192.168.209.128:1883';
  const options = {
    username: env.MQTT_USERNAME || 'gateway_admin',
    password: env.MQTT_PASSWORD || '123456'
  };

  if (url.startsWith('mqtts://')) {
    if (!env.MQTT_CA_FILE) {
      throw new Error('MQTT_URL dùng mqtts:// nhưng thiếu MQTT_CA_FILE (đường dẫn tới ca.crt, tạo bằng tools/gen-certs.sh)');
    }
    const caPath = path.resolve(baseDir, env.MQTT_CA_FILE);
    if (!fs.existsSync(caPath)) {
      throw new Error(`Không tìm thấy chứng chỉ CA: ${caPath} – chạy "bash tools/gen-certs.sh" ở thư mục gốc dự án`);
    }
    options.ca = fs.readFileSync(caPath);
    options.rejectUnauthorized = true;
  }
  return { url, options };
}

module.exports = { buildMqttOptions };
