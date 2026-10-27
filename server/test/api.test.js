const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createOtpService } = require('../src/otp');
const { createEventLog } = require('../src/events');
const { createMemoryStore } = require('../src/store');

const fakeBridge = () => ({
  getLocker: () => ({ online: true, lock: 'LOCKED', door: 'CLOSED' }),
  isBrokerConnected: () => true,
  sendUnlock: () => true,
  onChange() {}
});

async function start(store = createMemoryStore()) {
  const ctx = createApp({ otp: createOtpService(), log: createEventLog(), bridge: fakeBridge(), store, mqttUrl: 'mqtt://x' });
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p);
  const post = (p) => fetch(base + p, { method: 'POST' });
  return { ctx, store, get, post, close: () => new Promise((r) => server.close(r)) };
}

async function seed(store) {
  const d = (s) => new Date(s);
  const a = await store.insertAccess({
    unlockedAt: d('2026-10-25T14:02:31'), method: 'OTP', failedAttemptsBefore: 2,
    doorOpenedAt: d('2026-10-25T14:02:33'), doorClosedAt: d('2026-10-25T14:02:51'), openDurationSec: 18,
    lockedAt: d('2026-10-25T14:02:51'), lockReason: 'DOOR_CLOSED', status: 'DONE', anomalies: ['DOOR_AJAR']
  });
  await store.insertAccess({
    unlockedAt: d('2026-10-27T09:00:00'), method: 'REMOTE', failedAttemptsBefore: 0,
    doorOpenedAt: null, doorClosedAt: null, openDurationSec: null,
    lockedAt: d('2026-10-27T09:00:06'), lockReason: 'TIMEOUT', status: 'DONE', anomalies: []
  });
  const an = await store.insertAnomaly({ type: 'TAMPER', severity: 'CRITICAL', message: 'Cạy cửa', at: d('2026-10-27T10:00:00'), accessLogId: null, resolved: false, resolvedAt: null });
  await store.insertAnomaly({ type: 'DOOR_AJAR', severity: 'WARN', message: 'Cửa mở lâu', at: d('2026-10-25T14:03:33'), accessLogId: a, resolved: true, resolvedAt: d('2026-10-25T15:00:00') });
  return { accessId: a, anomalyId: an };
}

test('GET /api/state co db, so bat thuong chua xu ly, logsVersion', async () => {
  const s = await start();
  await seed(s.store);
  await s.ctx.refreshStats();
  const st = await (await s.get('/api/state')).json();
  assert.equal(st.db.connected, true);
  assert.equal(st.anomalies.unresolved, 1);
  assert.equal(typeof st.logsVersion, 'number');
  await s.close();
});

test('notifyLogsChanged tang logsVersion', async () => {
  const s = await start();
  const v0 = (await (await s.get('/api/state')).json()).logsVersion;
  await s.ctx.notifyLogsChanged();
  const v1 = (await (await s.get('/api/state')).json()).logsVersion;
  assert.equal(v1, v0 + 1);
  await s.close();
});

test('GET /api/access-logs tra danh sach moi nhat truoc + total', async () => {
  const s = await start();
  await seed(s.store);
  const r = await (await s.get('/api/access-logs')).json();
  assert.equal(r.total, 2);
  assert.equal(r.page, 1);
  assert.equal(r.items[0].method, 'REMOTE');
  assert.equal(r.items[1].openDurationSec, 18);
  assert.equal(new Date(r.items[1].unlockedAt).getHours(), 14);
  await s.close();
});

test('GET /api/access-logs loc theo ngay (ca ngay cuoi) va method', async () => {
  const s = await start();
  await seed(s.store);
  const r1 = await (await s.get('/api/access-logs?from=2026-10-25&to=2026-10-25')).json();
  assert.equal(r1.total, 1);
  const r2 = await (await s.get('/api/access-logs?method=REMOTE')).json();
  assert.equal(r2.total, 1);
  assert.equal(r2.items[0].method, 'REMOTE');
  await s.close();
});

test('GET /api/access-logs ngay sai dinh dang -> 400', async () => {
  const s = await start();
  assert.equal((await s.get('/api/access-logs?from=27-10-2026')).status, 400);
  assert.equal((await s.get('/api/access-logs?method=KEY')).status, 400);
  await s.close();
});

test('GET /api/access-logs.csv: BOM, tieu de tieng Viet, ngay dd/mm/yyyy', async () => {
  const s = await start();
  await seed(s.store);
  const res = await s.get('/api/access-logs.csv?method=OTP');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="nhat-ky-mo-khoa/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = buf.toString('utf8').slice(1).trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Thời điểm mở khóa,Cách mở,/);
  assert.match(lines[1], /^25\/10\/2026 14:02:31,Nhập OTP,2,25\/10\/2026 14:02:33,25\/10\/2026 14:02:51,18,/);
  assert.match(lines[1], /Cửa mở quá lâu/);
  await s.close();
});

test('GET /api/anomalies status=open chi lay chua xu ly; all lay het', async () => {
  const s = await start();
  await seed(s.store);
  const open = await (await s.get('/api/anomalies?status=open')).json();
  assert.deepEqual(open.items.map((a) => a.type), ['TAMPER']);
  const all = await (await s.get('/api/anomalies?status=all')).json();
  assert.equal(all.total, 2);
  await s.close();
});

test('POST /api/anomalies/:id/resolve -> 200, giam so chua xu ly; lan 2 -> 404', async () => {
  const s = await start();
  const { anomalyId } = await seed(s.store);
  await s.ctx.refreshStats();
  const r = await s.post(`/api/anomalies/${anomalyId}/resolve`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).anomalies.unresolved, 0);
  assert.equal((await s.post(`/api/anomalies/${anomalyId}/resolve`)).status, 404);
  await s.close();
});

test('MongoDB mat ket noi -> API nhat ky tra 503, /api/state van chay', async () => {
  const store = createMemoryStore();
  store.isConnected = () => false;
  const boom = async () => { throw new Error('MongoDB chưa kết nối'); };
  Object.assign(store, { listAccess: boom, listAnomalies: boom, resolveAnomaly: boom, countUnresolved: boom });
  const s = await start(store);
  assert.equal((await s.get('/api/access-logs')).status, 503);
  assert.equal((await s.get('/api/anomalies')).status, 503);
  assert.equal((await s.post('/api/anomalies/abc/resolve')).status, 503);
  const st = await (await s.get('/api/state')).json();
  assert.equal(st.db.connected, false);
  await s.ctx.refreshStats(); // không throw
  await s.close();
});
