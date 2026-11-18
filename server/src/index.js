// Smart Locker - Web server quản lý OTP + nhật ký mở khóa.
// Web là nơi duy nhất giữ mã OTP; tủ ESP32 hỏi qua MQTT (xem mqttBridge.js).
// Nhật ký mở khóa và bất thường lưu vào MongoDB (xem accessTracker.js, store.js).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const mqtt = require('mqtt');
const { createOtpService } = require('./otp');
const { createEventLog } = require('./events');
const { createMqttBridge } = require('./mqttBridge');
const { createMongoStore } = require('./store');
const { createAccessTracker } = require('./accessTracker');
const { createApp, ANOMALY_LABEL } = require('./app');
const { createAuth, parseUsers } = require('./auth');
const { buildMqttOptions } = require('./mqttOptions');

const env = process.env;
const num = (name, fallback) => {
  const v = parseFloat(env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const PORT = num('PORT', 5000);
const { url: MQTT_URL, options: MQTT_OPTIONS } = buildMqttOptions(env, path.join(__dirname, '..'));
const MONGODB_URI = env.MONGODB_URI || 'mongodb://127.0.0.1:27017/smartlockerlogs';
const OTP_TTL_MIN = num('OTP_TTL_MIN', 10) || 10;

const log = createEventLog({ limit: 100 });
const otp = createOtpService({ ttlMs: Math.round(OTP_TTL_MIN * 60_000) });
const store = createMongoStore(MONGODB_URI);

let ctx; // express app context, tạo ở dưới
const tracker = createAccessTracker({
  store,
  config: {
    doorAjarSec: num('DOOR_AJAR_SEC', 60),
    afterHoursStart: num('AFTER_HOURS_START', 23),
    afterHoursEnd: num('AFTER_HOURS_END', 5),
    frequentCount: num('FREQUENT_UNLOCK_COUNT', 5),
    frequentWindowMin: num('FREQUENT_UNLOCK_WINDOW_MIN', 10),
    offlineAlertMin: num('OFFLINE_ALERT_MIN', 2)
  },
  onChange: (kind, anomaly) => {
    if (kind === 'anomaly') {
      log.add(anomaly.severity === 'CRITICAL' ? 'CRITICAL' : 'WARN', `ANOMALY_${anomaly.type}`,
        `${ANOMALY_LABEL[anomaly.type] || anomaly.type}: ${anomaly.message}`);
    }
    ctx.notifyLogsChanged();
  }
});

const client = mqtt.connect(MQTT_URL, {
  ...MQTT_OPTIONS,
  clientId: 'smartlocker-web-' + crypto.randomBytes(3).toString('hex'),
  reconnectPeriod: 3000,
  connectTimeout: 5000
});
client.on('error', (err) => console.error(`[MQTT] ${err.message}`));
client.on('offline', () => console.warn(`[MQTT] Không kết nối được ${MQTT_URL}, thử lại sau 3s...`));

const bridge = createMqttBridge({ client, otp, log, tracker });
// HTTPS cho dashboard (tùy chọn): có cả HTTPS_CERT_FILE và HTTPS_KEY_FILE thì chạy https
const tls = env.HTTPS_CERT_FILE && env.HTTPS_KEY_FILE
  ? { cert: fs.readFileSync(path.resolve(__dirname, '..', env.HTTPS_CERT_FILE)), key: fs.readFileSync(path.resolve(__dirname, '..', env.HTTPS_KEY_FILE)) }
  : null;

// Đăng nhập JWT + phân quyền. Thiếu JWT_SECRET thì tạo ngẫu nhiên (khởi động lại server là phải đăng nhập lại)
let jwtSecret = env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 16) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[AUTH] Chưa đặt JWT_SECRET (>= 16 ký tự) trong .env – dùng khóa ngẫu nhiên cho lần chạy này');
}
const users = parseUsers(env.AUTH_USERS || 'admin:admin123:admin,cudan:cudan123:resident');
if (!env.AUTH_USERS) console.warn('[AUTH] Chưa đặt AUTH_USERS – đang dùng tài khoản mặc định, hãy đổi mật khẩu trong .env');
const auth = createAuth({ users, secret: jwtSecret, ttlSec: Math.round(num('JWT_TTL_HOURS', 8) * 3600) || 3600, secureCookie: !!tls });

ctx = createApp({ otp, log, bridge, store, mqttUrl: MQTT_URL, auth });

log.onChange(ctx.broadcast);
bridge.onChange(ctx.broadcast);
store.onConnectionChange((connected) => {
  log.add(connected ? 'INFO' : 'WARN', connected ? 'DB_CONNECTED' : 'DB_DISCONNECTED',
    connected ? 'Đã kết nối MongoDB' : 'Mất kết nối MongoDB – nhật ký mở khóa tạm không được lưu');
  ctx.refreshStats();
});

setInterval(() => {
  if (otp.tick()) log.add('INFO', 'OTP_ROTATED', `Mã OTP hết hạn ${OTP_TTL_MIN} phút → đã tạo mã mới`);
  tracker.tick();
}, 1000);

store.ready().then(() => ctx.refreshStats());

const httpServer = tls ? https.createServer(tls, ctx.app) : ctx.app;
httpServer.listen(PORT, () => {
  console.log('==============================================');
  console.log(' Smart Locker - Web quản lý OTP');
  console.log(` Dashboard : ${tls ? 'https' : 'http'}://localhost:${PORT}`);
  console.log(` Broker    : ${MQTT_URL}${MQTT_OPTIONS.ca ? ' (TLS, kiểm tra chứng chỉ bằng CA nhóm)' : ' (không mã hóa)'}`);
  console.log(` Tài khoản : ${users.map((u) => `${u.username}/${u.role}`).join(', ')}`);
  console.log(` MongoDB   : ${MONGODB_URI}`);
  console.log(` OTP TTL   : ${OTP_TTL_MIN} phút`);
  console.log('==============================================');
  log.add('INFO', 'SERVER_STARTED', 'Server khởi động, đã tạo mã OTP đầu tiên');
});
