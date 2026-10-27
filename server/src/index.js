// Smart Locker - Web server quản lý OTP + nhật ký mở khóa.
// Web là nơi duy nhất giữ mã OTP; tủ ESP32 hỏi qua MQTT (xem mqttBridge.js).
// Nhật ký mở khóa và bất thường lưu vào MongoDB (xem accessTracker.js, store.js).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const mqtt = require('mqtt');
const { createOtpService } = require('./otp');
const { createEventLog } = require('./events');
const { createMqttBridge } = require('./mqttBridge');
const { createMongoStore } = require('./store');
const { createAccessTracker } = require('./accessTracker');
const { createApp, ANOMALY_LABEL } = require('./app');

const env = process.env;
const num = (name, fallback) => {
  const v = parseFloat(env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const PORT = num('PORT', 5000);
const MQTT_URL = env.MQTT_URL || 'mqtt://192.168.209.128:1883';
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
  username: env.MQTT_USERNAME || 'gateway_admin',
  password: env.MQTT_PASSWORD || '123456',
  clientId: 'smartlocker-web-' + crypto.randomBytes(3).toString('hex'),
  reconnectPeriod: 3000,
  connectTimeout: 5000
});
client.on('error', (err) => console.error(`[MQTT] ${err.message}`));
client.on('offline', () => console.warn(`[MQTT] Không kết nối được ${MQTT_URL}, thử lại sau 3s...`));

const bridge = createMqttBridge({ client, otp, log, tracker });
ctx = createApp({ otp, log, bridge, store, mqttUrl: MQTT_URL });

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

ctx.app.listen(PORT, () => {
  console.log('==============================================');
  console.log(' Smart Locker - Web quản lý OTP');
  console.log(` Dashboard : http://localhost:${PORT}`);
  console.log(` Broker    : ${MQTT_URL}`);
  console.log(` MongoDB   : ${MONGODB_URI}`);
  console.log(` OTP TTL   : ${OTP_TTL_MIN} phút`);
  console.log('==============================================');
  log.add('INFO', 'SERVER_STARTED', 'Server khởi động, đã tạo mã OTP đầu tiên');
});
