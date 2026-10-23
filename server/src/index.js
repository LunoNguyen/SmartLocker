// Smart Locker - Web server quản lý OTP.
// Web là nơi duy nhất giữ mã OTP; tủ ESP32 hỏi qua MQTT (xem mqttBridge.js).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const express = require('express');
const mqtt = require('mqtt');
const { createOtpService } = require('./otp');
const { createEventLog } = require('./events');
const { createMqttBridge } = require('./mqttBridge');

const PORT = parseInt(process.env.PORT || '5000', 10);
const MQTT_URL = process.env.MQTT_URL || 'mqtt://192.168.209.128:1883';
const OTP_TTL_MIN = parseFloat(process.env.OTP_TTL_MIN || '10');

const log = createEventLog({ limit: 100 });
const otp = createOtpService({ ttlMs: Math.round(OTP_TTL_MIN * 60_000) });

const client = mqtt.connect(MQTT_URL, {
  username: process.env.MQTT_USERNAME || 'gateway_admin',
  password: process.env.MQTT_PASSWORD || '123456',
  clientId: 'smartlocker-web-' + crypto.randomBytes(3).toString('hex'),
  reconnectPeriod: 3000,
  connectTimeout: 5000
});
client.on('error', (err) => console.error(`[MQTT] ${err.message}`));
client.on('offline', () => console.warn(`[MQTT] Không kết nối được ${MQTT_URL}, thử lại sau 3s...`));

const bridge = createMqttBridge({ client, otp, log });

// --- Trạng thái gửi cho trình duyệt ---
function snapshot() {
  return {
    otp: otp.getState(),
    locker: bridge.getLocker(),
    broker: { connected: bridge.isBrokerConnected(), url: MQTT_URL },
    log: log.list(),
    serverTime: Date.now()
  };
}

const sseClients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  sseClients.forEach((res) => res.write(msg));
}
log.onChange(broadcast);
bridge.onChange(broadcast);

setInterval(() => {
  if (otp.tick()) log.add('INFO', 'OTP_ROTATED', `Mã OTP hết hạn ${OTP_TTL_MIN} phút → đã tạo mã mới`);
}, 1000);

// --- HTTP ---
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/state', (req, res) => res.json(snapshot()));

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

app.post('/api/otp/rotate', (req, res) => {
  otp.rotate();
  log.add('INFO', 'OTP_CREATED', 'Admin tạo mã OTP mới');
  res.json(snapshot());
});

app.post('/api/otp/revoke', (req, res) => {
  otp.revoke();
  log.add('WARN', 'OTP_REVOKED', 'Admin hủy mã OTP – tủ không có mã cho tới khi tạo mới');
  res.json(snapshot());
});

app.post('/api/lockout/clear', (req, res) => {
  otp.clearLockout();
  log.add('INFO', 'LOCKOUT_CLEARED', 'Admin gỡ khóa bàn phím');
  res.json(snapshot());
});

app.post('/api/unlock', (req, res) => {
  if (!bridge.sendUnlock()) {
    log.add('WARN', 'REMOTE_UNLOCK_FAILED', 'Không gửi được lệnh mở: server mất kết nối broker');
    return res.status(503).json(snapshot());
  }
  log.add('INFO', 'REMOTE_UNLOCK', 'Admin gửi lệnh mở khóa từ xa');
  res.json(snapshot());
});

app.listen(PORT, () => {
  console.log('==============================================');
  console.log(' Smart Locker - Web quản lý OTP');
  console.log(` Dashboard : http://localhost:${PORT}`);
  console.log(` Broker    : ${MQTT_URL}`);
  console.log(` OTP TTL   : ${OTP_TTL_MIN} phút`);
  console.log('==============================================');
  log.add('INFO', 'SERVER_STARTED', 'Server khởi động, đã tạo mã OTP đầu tiên');
});
