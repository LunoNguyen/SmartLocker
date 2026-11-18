const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMqttOptions } = require('../src/mqttOptions');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqttopt-'));
fs.writeFileSync(path.join(tmp, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');

test('mqtts + CA file tuong doi -> doc CA, bat kiem tra chung chi', () => {
  const { url, options } = buildMqttOptions({
    MQTT_URL: 'mqtts://192.168.209.128:8883', MQTT_CA_FILE: 'ca.crt', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p'
  }, tmp);
  assert.equal(url, 'mqtts://192.168.209.128:8883');
  assert.match(options.ca.toString(), /BEGIN CERTIFICATE/);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.username, 'u');
  assert.equal(options.password, 'p');
});

test('mqtts nhung khong co MQTT_CA_FILE -> bao loi ro rang', () => {
  assert.throws(() => buildMqttOptions({ MQTT_URL: 'mqtts://1.2.3.4:8883' }, tmp), /MQTT_CA_FILE/);
});

test('MQTT_CA_FILE tro toi file khong ton tai -> bao loi co duong dan', () => {
  assert.throws(() => buildMqttOptions({ MQTT_URL: 'mqtts://1.2.3.4:8883', MQTT_CA_FILE: 'khong-co.crt' }, tmp), /khong-co\.crt/);
});

test('mqtt:// (khong ma hoa) -> khong co ca, van chay duoc', () => {
  const { options } = buildMqttOptions({ MQTT_URL: 'mqtt://127.0.0.1:1883' }, tmp);
  assert.equal(options.ca, undefined);
});

test('mac dinh: khong ma hoa toi broker VM cong 1883, tai khoan gateway_admin', () => {
  const { url, options } = buildMqttOptions({}, tmp);
  assert.equal(url, 'mqtt://192.168.209.128:1883');
  assert.equal(options.ca, undefined);
  assert.equal(options.username, 'gateway_admin');
});
