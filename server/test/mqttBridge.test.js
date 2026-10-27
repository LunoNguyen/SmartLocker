const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMqttBridge } = require('../src/mqttBridge');
const { createEventLog } = require('../src/events');

const P = 'smartlocker/locker1/';

function fakeClient() {
  const c = new EventEmitter();
  c.connected = true;
  c.sent = [];
  c.subscribed = [];
  c.publish = (topic, payload, opts) => { c.sent.push({ topic, payload, opts }); };
  c.subscribe = (topics) => { c.subscribed.push(...[].concat(topics)); };
  return c;
}

function fakeOtp(result, code = '777777') {
  return { calls: [], verify(req, input) { this.calls.push([req, input]); return result; }, getState: () => ({ code }) };
}

function setup(result) {
  const client = fakeClient();
  const otp = fakeOtp(result);
  const log = createEventLog({ limit: 100 });
  const bridge = createMqttBridge({ client, otp, log, prefix: P });
  return { client, otp, log, bridge };
}

const send = (client, topic, obj, retain = false) =>
  client.emit('message', P + topic, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), { retain });

test('connect -> subscribe verify, status, events', () => {
  const { client } = setup(null);
  client.emit('connect');
  assert.deepEqual(client.subscribed.sort(), [P + 'events', P + 'status', P + 'verify'].sort());
});

test('verify hop le -> publish verify/result {req, ok:true}, bo truong noi bo', () => {
  const { client, otp } = setup({ ok: true, rotated: true });
  send(client, 'verify', { req: 'a1b2c3d4', code: '777777' });
  assert.deepEqual(otp.calls, [['a1b2c3d4', '777777']]);
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].topic, P + 'verify/result');
  assert.deepEqual(JSON.parse(client.sent[0].payload), { req: 'a1b2c3d4', ok: true });
});

test('verify WRONG -> publish result co attempts_left, log WARN', () => {
  const { client, log } = setup({ ok: false, reason: 'WRONG', attempts_left: 2 });
  send(client, 'verify', { req: 'r', code: '000000' });
  assert.deepEqual(JSON.parse(client.sent[0].payload), { req: 'r', ok: false, reason: 'WRONG', attempts_left: 2 });
  assert.equal(log.list()[0].level, 'WARN');
});

test('verify tra null (req trung) -> khong publish', () => {
  const { client } = setup(null);
  send(client, 'verify', { req: 'r', code: '000000' });
  assert.equal(client.sent.length, 0);
});

test('verify INVALID -> khong publish, log WARN', () => {
  const { client, log } = setup({ ok: false, reason: 'INVALID' });
  send(client, 'verify', { req: 'r', code: 12 });
  assert.equal(client.sent.length, 0);
  assert.equal(log.list()[0].level, 'WARN');
});

test('verify JSON hong -> khong publish, khong goi otp, khong throw', () => {
  const { client, otp } = setup({ ok: true });
  assert.doesNotThrow(() => send(client, 'verify', '{khong phai json'));
  assert.equal(otp.calls.length, 0);
  assert.equal(client.sent.length, 0);
});

test('tin verify retained -> bo qua', () => {
  const { client, otp } = setup({ ok: true });
  send(client, 'verify', { req: 'r', code: '777777' }, true);
  assert.equal(otp.calls.length, 0);
  assert.equal(client.sent.length, 0);
});

test('LOCKED_OUT critical -> log CRITICAL, result khong co critical', () => {
  const { client, log } = setup({ ok: false, reason: 'LOCKED_OUT', retry_in: 300, critical: true });
  send(client, 'verify', { req: 'r', code: '000000' });
  assert.equal(log.list()[0].level, 'CRITICAL');
  assert.deepEqual(JSON.parse(client.sent[0].payload), { req: 'r', ok: false, reason: 'LOCKED_OUT', retry_in: 300 });
});

test('verify ok -> log SUCCESS', () => {
  const { client, log } = setup({ ok: true, rotated: true });
  send(client, 'verify', { req: 'r', code: '777777' });
  assert.equal(log.list()[0].level, 'SUCCESS');
});

test('status cap nhat getLocker va goi onChange', () => {
  const { client, bridge } = setup(null);
  let changes = 0;
  bridge.onChange(() => changes++);
  send(client, 'status', { online: true, lock: 'UNLOCKED', door: 'OPEN' });
  assert.deepEqual(bridge.getLocker(), { online: true, lock: 'UNLOCKED', door: 'OPEN' });
  send(client, 'status', { online: false });
  assert.equal(bridge.getLocker().online, false);
  assert.equal(changes, 2);
});

test('status online -> offline ghi log LOCKER_OFFLINE', () => {
  const { client, log } = setup(null);
  send(client, 'status', { online: true, lock: 'LOCKED', door: 'CLOSED' });
  send(client, 'status', { online: false });
  assert.equal(log.list()[0].event, 'LOCKER_OFFLINE');
});

test('events TAMPER -> log CRITICAL; event khac -> INFO', () => {
  const { client, log } = setup(null);
  send(client, 'events', { event: 'DOOR_OPENED', source: 'SENSOR' });
  assert.equal(log.list()[0].level, 'INFO');
  send(client, 'events', { event: 'TAMPER', source: 'SENSOR' });
  assert.equal(log.list()[0].level, 'CRITICAL');
  assert.equal(log.list()[0].event, 'TAMPER');
});

test('sendUnlock -> publish command {"cmd":"UNLOCK"}, tra false khi mat broker', () => {
  const { client, bridge } = setup(null);
  assert.equal(bridge.sendUnlock(), true);
  assert.equal(client.sent[0].topic, P + 'command');
  assert.deepEqual(JSON.parse(client.sent[0].payload), { cmd: 'UNLOCK' });
  client.connected = false;
  assert.equal(bridge.sendUnlock(), false);
  assert.equal(client.sent.length, 1);
});

test('close/connect cap nhat isBrokerConnected va goi onChange', () => {
  const { client, bridge } = setup(null);
  let changes = 0;
  bridge.onChange(() => changes++);
  client.connected = false;
  client.emit('close');
  assert.equal(bridge.isBrokerConnected(), false);
  client.connected = true;
  client.emit('connect');
  assert.equal(bridge.isBrokerConnected(), true);
  assert.equal(changes, 2);
});

test('payload result va log khong bao gio chua ma hien tai', () => {
  const { client, log } = setup({ ok: false, reason: 'WRONG', attempts_left: 1 });
  send(client, 'verify', { req: 'r', code: '000000' });
  assert.ok(!JSON.stringify(client.sent).includes('777777'));
  assert.ok(!JSON.stringify(log.list()).includes('777777'));
});

test('event log giu toi da limit dong, moi nhat truoc, goi onChange', () => {
  const log = createEventLog({ limit: 2 });
  let n = 0;
  log.onChange(() => n++);
  log.add('INFO', 'A', '');
  log.add('INFO', 'B', '');
  log.add('WARN', 'C', 'x');
  assert.deepEqual(log.list().map((e) => e.event), ['C', 'B']);
  assert.equal(typeof log.list()[0].ts, 'number');
  assert.equal(n, 3);
});

function spyTracker() {
  const calls = [];
  return {
    calls,
    handleVerifyResult: (r) => calls.push(['verify', r]),
    handleEvent: (e, s) => calls.push(['event', e, s]),
    handleStatus: (o) => calls.push(['status', o])
  };
}

test('tracker nhan ket qua verify (ke ca co noi bo), payload gui ESP32 khong co lockStarted', () => {
  const client = fakeClient();
  const tracker = spyTracker();
  const r = { ok: false, reason: 'LOCKED_OUT', retry_in: 30, lockStarted: true };
  createMqttBridge({ client, otp: fakeOtp(r), log: createEventLog(), prefix: P, tracker });
  send(client, 'verify', { req: 'r', code: '000000' });
  assert.deepEqual(tracker.calls, [['verify', r]]);
  assert.deepEqual(JSON.parse(client.sent[0].payload), { req: 'r', ok: false, reason: 'LOCKED_OUT', retry_in: 30 });
});

test('tracker khong nhan verify INVALID / req trung', () => {
  const client = fakeClient();
  const tracker = spyTracker();
  createMqttBridge({ client, otp: fakeOtp({ ok: false, reason: 'INVALID' }), log: createEventLog(), prefix: P, tracker });
  send(client, 'verify', { req: 'r', code: 1 });
  assert.equal(tracker.calls.length, 0);
});

test('tracker nhan events va status cua tu', () => {
  const client = fakeClient();
  const tracker = spyTracker();
  createMqttBridge({ client, otp: fakeOtp(null), log: createEventLog(), prefix: P, tracker });
  send(client, 'events', { event: 'UNLOCKED', source: 'OTP' });
  send(client, 'status', { online: false });
  assert.deepEqual(tracker.calls, [['event', 'UNLOCKED', 'OTP'], ['status', false]]);
});

test('server mat broker (close) -> khong bao tracker la tu offline', () => {
  const client = fakeClient();
  const tracker = spyTracker();
  createMqttBridge({ client, otp: fakeOtp(null), log: createEventLog(), prefix: P, tracker });
  client.emit('close');
  assert.equal(tracker.calls.length, 0);
});
