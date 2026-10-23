#!/usr/bin/env node
// Giả lập tủ ESP32 để test web + Mosquitto mà không cần Wokwi.
//
//   node tools/fake-locker.js 123456     gửi mã, in kết quả (exit 0 = đúng, 1 = sai, 2 = timeout)
//   node tools/fake-locker.js --listen   giữ tủ online và in mọi lệnh nhận được (Ctrl+C để thoát)

const path = require('path');
const crypto = require('crypto');
const serverDir = path.join(__dirname, '..', 'server');
require(path.join(serverDir, 'node_modules', 'dotenv')).config({ path: path.join(serverDir, '.env') });
const mqtt = require(path.join(serverDir, 'node_modules', 'mqtt'));

const PREFIX = 'smartlocker/locker1/';
const TIMEOUT_MS = 5000;
const arg = process.argv[2];

if (!arg) {
  console.log('Cách dùng: node tools/fake-locker.js <ma 6 so> | --listen');
  process.exit(2);
}

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://192.168.209.128:1883', {
  username: process.env.MQTT_USERNAME || 'gateway_admin',
  password: process.env.MQTT_PASSWORD || '123456',
  clientId: 'fake-locker-' + crypto.randomBytes(3).toString('hex'),
  connectTimeout: 5000,
  reconnectPeriod: 0,
  will: { topic: PREFIX + 'status', payload: JSON.stringify({ online: false }), retain: true, qos: 0 }
});

function finish(code) {
  client.publish(PREFIX + 'status', JSON.stringify({ online: false }), { retain: true }, () => {
    client.end(false, () => process.exit(code));
  });
}

client.on('error', (err) => {
  console.error('Lỗi MQTT:', err.message);
  process.exit(2);
});

client.on('connect', () => {
  client.publish(PREFIX + 'status', JSON.stringify({ online: true, lock: 'LOCKED', door: 'CLOSED' }), { retain: true });

  if (arg === '--listen') {
    client.subscribe(PREFIX + 'command');
    console.log('Tủ giả đang online, chờ lệnh... (Ctrl+C để thoát)');
    client.on('message', (t, p) => console.log(`[${t}] ${p}`));
    process.on('SIGINT', () => finish(0));
    return;
  }

  const req = crypto.randomBytes(4).toString('hex');
  const timer = setTimeout(() => {
    console.log(`TIMEOUT: không có phản hồi sau ${TIMEOUT_MS / 1000}s (web server có đang chạy?)`);
    finish(2);
  }, TIMEOUT_MS);

  client.subscribe(PREFIX + 'verify/result', () => {
    client.on('message', (t, p) => {
      let res;
      try { res = JSON.parse(p.toString()); } catch { return; }
      if (res.req !== req) return;
      clearTimeout(timer);
      console.log(JSON.stringify(res));
      finish(res.ok ? 0 : 1);
    });
    console.log(`Gửi verify req=${req} code=${arg}`);
    client.publish(PREFIX + 'verify', JSON.stringify({ req, code: arg }));
  });
});
