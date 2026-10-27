const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccessTracker } = require('../src/accessTracker');
const { createMemoryStore } = require('../src/store');

// Giờ trưa để không dính "ngoài giờ" trừ khi test chủ động đổi
function setup({ start = '2026-10-27T12:00:00', config = {}, store = createMemoryStore() } = {}) {
  const clock = { t: new Date(start).getTime() };
  const changes = [];
  const tracker = createAccessTracker({
    store,
    now: () => clock.t,
    config,
    onChange: (kind, data) => changes.push({ kind, data })
  });
  const advance = (sec) => { clock.t += sec * 1000; };
  const logs = async () => { await tracker.flush(); return (await store.listAccess({})).items; };
  const anomalies = async () => { await tracker.flush(); return (await store.listAnomalies({})).items; };
  return { tracker, store, clock, advance, logs, anomalies, changes };
}

const WRONG = { ok: false, reason: 'WRONG', attempts_left: 2 };
const OK = { ok: true, rotated: true };

test('UNLOCKED OTP -> tao ban ghi IN_PROGRESS', async () => {
  const { tracker, clock, logs } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  const [log] = await logs();
  assert.equal(log.method, 'OTP');
  assert.equal(log.status, 'IN_PROGRESS');
  assert.equal(log.unlockedAt.getTime(), clock.t);
  assert.deepEqual(log.anomalies, []);
});

test('phien day du: mo cua 2s sau, dong sau 18s -> thoi luong 18, khoa DOOR_CLOSED', async () => {
  const { tracker, advance, logs } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  advance(2); tracker.handleEvent('DOOR_OPENED', 'SENSOR');
  advance(18); tracker.handleEvent('DOOR_CLOSED', 'SENSOR');
  tracker.handleEvent('LOCKED', 'DOOR_CLOSED');
  const [log] = await logs();
  assert.equal(log.openDurationSec, 18);
  assert.equal(log.doorClosedAt - log.doorOpenedAt, 18000);
  assert.equal(log.lockReason, 'DOOR_CLOSED');
  assert.equal(log.status, 'DONE');
  assert.ok(log.lockedAt instanceof Date);
});

test('thoi luong lam tron theo giay', async () => {
  const { tracker, advance, logs } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  tracker.handleEvent('DOOR_OPENED', 'SENSOR');
  advance(7.6); tracker.handleEvent('DOOR_CLOSED', 'SENSOR');
  assert.equal((await logs())[0].openDurationSec, 8);
});

test('mo khoa nhung khong mo cua -> TIMEOUT, thoi luong null', async () => {
  const { tracker, advance, logs } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  advance(6); tracker.handleEvent('LOCKED', 'TIMEOUT');
  const [log] = await logs();
  assert.equal(log.openDurationSec, null);
  assert.equal(log.doorOpenedAt, null);
  assert.equal(log.lockReason, 'TIMEOUT');
  assert.equal(log.status, 'DONE');
});

test('so lan sai truoc khi mo duoc ghi; mo tu xa = 0', async () => {
  const { tracker, advance, logs } = setup();
  tracker.handleVerifyResult(WRONG);
  tracker.handleVerifyResult(WRONG);
  tracker.handleVerifyResult(OK);
  tracker.handleEvent('UNLOCKED', 'OTP');
  tracker.handleEvent('LOCKED', 'TIMEOUT');
  advance(1); tracker.handleEvent('UNLOCKED', 'REMOTE');
  const [remote, otp] = await logs();
  assert.equal(otp.failedAttemptsBefore, 2);
  assert.equal(remote.method, 'REMOTE');
  assert.equal(remote.failedAttemptsBefore, 0);
});

test('lan sai bat dau khoa 30s -> BRUTE_FORCE_WARN', async () => {
  const { tracker, anomalies } = setup();
  tracker.handleVerifyResult(WRONG);
  tracker.handleVerifyResult(WRONG);
  tracker.handleVerifyResult({ ok: false, reason: 'LOCKED_OUT', retry_in: 30, lockStarted: true });
  const [a] = await anomalies();
  assert.equal(a.type, 'BRUTE_FORCE_WARN');
  assert.equal(a.severity, 'WARN');
  assert.equal(a.resolved, false);
});

test('sai 5 lan -> BRUTE_FORCE_LOCK CRITICAL', async () => {
  const { tracker, anomalies } = setup();
  tracker.handleVerifyResult({ ok: false, reason: 'LOCKED_OUT', retry_in: 300, critical: true, lockStarted: true });
  const [a] = await anomalies();
  assert.equal(a.type, 'BRUTE_FORCE_LOCK');
  assert.equal(a.severity, 'CRITICAL');
});

test('LOCKED_OUT khi dang khoa san -> khong ghi bat thuong, khong tinh lan sai', async () => {
  const { tracker, anomalies, logs } = setup();
  tracker.handleVerifyResult({ ok: false, reason: 'LOCKED_OUT', retry_in: 20 });
  tracker.handleVerifyResult(OK);
  tracker.handleEvent('UNLOCKED', 'OTP');
  assert.equal((await anomalies()).length, 0);
  assert.equal((await logs())[0].failedAttemptsBefore, 0);
});

test('lan sai bat dau khoa cung duoc dem vao so lan sai', async () => {
  const { tracker, logs } = setup();
  tracker.handleVerifyResult(WRONG);
  tracker.handleVerifyResult(WRONG);
  tracker.handleVerifyResult({ ok: false, reason: 'LOCKED_OUT', retry_in: 30, lockStarted: true });
  tracker.handleVerifyResult(OK);
  tracker.handleEvent('UNLOCKED', 'OTP');
  assert.equal((await logs())[0].failedAttemptsBefore, 3);
});

test('TAMPER -> CRITICAL', async () => {
  const { tracker, anomalies } = setup();
  tracker.handleEvent('TAMPER', 'SENSOR');
  const [a] = await anomalies();
  assert.equal(a.type, 'TAMPER');
  assert.equal(a.severity, 'CRITICAL');
  assert.equal(a.accessLogId, null);
});

test('cua mo qua 60s -> DOOR_AJAR 1 lan, gan vao phien', async () => {
  const { tracker, advance, anomalies, logs } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  tracker.handleEvent('DOOR_OPENED', 'SENSOR');
  advance(59); tracker.tick();
  assert.equal((await anomalies()).length, 0);
  advance(1); tracker.tick();
  advance(30); tracker.tick();
  const list = await anomalies();
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'DOOR_AJAR');
  const [log] = await logs();
  assert.deepEqual(log.anomalies, ['DOOR_AJAR']);
  assert.equal(list[0].accessLogId, log.id);
});

test('nguong cua mo qua lau doi duoc qua config', async () => {
  const { tracker, advance, anomalies } = setup({ config: { doorAjarSec: 15 } });
  tracker.handleEvent('UNLOCKED', 'OTP');
  tracker.handleEvent('DOOR_OPENED', 'SENSOR');
  advance(15); tracker.tick();
  assert.equal((await anomalies())[0].type, 'DOOR_AJAR');
});

test('cua da dong -> khong bao DOOR_AJAR', async () => {
  const { tracker, advance, anomalies } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  tracker.handleEvent('DOOR_OPENED', 'SENSOR');
  advance(10); tracker.handleEvent('DOOR_CLOSED', 'SENSOR');
  tracker.handleEvent('LOCKED', 'DOOR_CLOSED');
  advance(100); tracker.tick();
  assert.equal((await anomalies()).length, 0);
});

for (const [time, expected] of [['23:30:00', true], ['04:59:00', true], ['05:00:00', false], ['12:00:00', false], ['22:59:59', false], ['23:00:00', true]]) {
  test(`mo khoa luc ${time} -> AFTER_HOURS ${expected}`, async () => {
    const { tracker, anomalies, logs } = setup({ start: `2026-10-27T${time}` });
    tracker.handleEvent('UNLOCKED', 'OTP');
    const list = await anomalies();
    assert.equal(list.some((a) => a.type === 'AFTER_HOURS'), expected);
    assert.equal((await logs())[0].anomalies.includes('AFTER_HOURS'), expected);
  });
}

test('hon 5 lan mo trong 10 phut -> FREQUENT_UNLOCK 1 lan moi cua so', async () => {
  const { tracker, advance, anomalies } = setup();
  const unlock = () => { tracker.handleEvent('UNLOCKED', 'REMOTE'); tracker.handleEvent('LOCKED', 'TIMEOUT'); advance(60); };
  for (let i = 0; i < 5; i++) unlock();
  assert.equal((await anomalies()).length, 0);
  unlock();                                   // lần thứ 6
  unlock();                                   // lần thứ 7: không báo lặp
  let list = (await anomalies()).filter((a) => a.type === 'FREQUENT_UNLOCK');
  assert.equal(list.length, 1);
  advance(600);                               // qua cửa sổ 10 phút
  for (let i = 0; i < 6; i++) unlock();
  list = (await anomalies()).filter((a) => a.type === 'FREQUENT_UNLOCK');
  assert.equal(list.length, 2);
});

test('mo cach nhau > 10 phut -> khong FREQUENT_UNLOCK', async () => {
  const { tracker, advance, anomalies } = setup();
  for (let i = 0; i < 8; i++) { tracker.handleEvent('UNLOCKED', 'REMOTE'); tracker.handleEvent('LOCKED', 'TIMEOUT'); advance(150); }
  assert.equal((await anomalies()).length, 0);
});

test('tu offline 2 phut -> LOCKER_OFFLINE 1 lan; online lai roi offline -> bao lai', async () => {
  const { tracker, advance, anomalies } = setup();
  tracker.handleStatus(true);
  tracker.handleStatus(false);
  advance(119); tracker.tick();
  assert.equal((await anomalies()).length, 0);
  advance(1); tracker.tick();
  advance(60); tracker.tick();
  assert.equal((await anomalies()).length, 1);
  tracker.handleStatus(true);
  tracker.handleStatus(false);
  advance(120); tracker.tick();
  const list = await anomalies();
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => a.type === 'LOCKER_OFFLINE'));
});

test('offline roi online truoc 2 phut -> khong bao', async () => {
  const { tracker, advance, anomalies } = setup();
  tracker.handleStatus(false);
  advance(60); tracker.handleStatus(true);
  advance(120); tracker.tick();
  assert.equal((await anomalies()).length, 0);
});

test('nhan status false nhieu lan khong reset moc offline', async () => {
  const { tracker, advance, anomalies } = setup();
  tracker.handleStatus(false);
  advance(100); tracker.handleStatus(false);
  advance(20); tracker.tick();
  assert.equal((await anomalies()).length, 1);
});

test('LOCKED / DOOR_* khi khong co phien -> bo qua', async () => {
  const { tracker, logs } = setup();
  tracker.handleEvent('DOOR_OPENED', 'SENSOR');
  tracker.handleEvent('DOOR_CLOSED', 'SENSOR');
  tracker.handleEvent('LOCKED', 'TIMEOUT');
  assert.equal((await logs()).length, 0);
});

test('UNLOCKED khi phien cu chua dong -> dong phien cu voi UNKNOWN', async () => {
  const { tracker, advance, logs } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  advance(5); tracker.handleEvent('UNLOCKED', 'REMOTE');
  const [newer, older] = await logs();
  assert.equal(newer.status, 'IN_PROGRESS');
  assert.equal(older.status, 'DONE');
  assert.equal(older.lockReason, 'UNKNOWN');
});

test('su kien la -> bo qua, khong throw', async () => {
  const { tracker, logs, anomalies } = setup();
  assert.doesNotThrow(() => tracker.handleEvent('XYZ', 'abc'));
  assert.equal((await logs()).length, 0);
  assert.equal((await anomalies()).length, 0);
});

test('store loi -> khong throw, flush van xong, cac ghi sau van chay', async () => {
  const store = createMemoryStore();
  let fail = true;
  const realInsert = store.insertAccess;
  store.insertAccess = async (doc) => { if (fail) throw new Error('DB tat'); return realInsert(doc); };
  const { tracker, logs } = setup({ store });
  tracker.handleEvent('UNLOCKED', 'OTP');
  tracker.handleEvent('DOOR_OPENED', 'SENSOR');   // phiên không có id -> bỏ qua update
  tracker.handleEvent('LOCKED', 'TIMEOUT');
  await tracker.flush();
  fail = false;
  tracker.handleEvent('UNLOCKED', 'OTP');
  assert.equal((await logs()).length, 1);
});

test('onChange bao access va anomaly', async () => {
  const { tracker, changes } = setup();
  tracker.handleEvent('UNLOCKED', 'OTP');
  tracker.handleEvent('TAMPER', 'SENSOR');
  await tracker.flush();
  assert.ok(changes.some((c) => c.kind === 'access'));
  const a = changes.find((c) => c.kind === 'anomaly');
  assert.equal(a.data.type, 'TAMPER');
  assert.equal(typeof a.data.message, 'string');
});
