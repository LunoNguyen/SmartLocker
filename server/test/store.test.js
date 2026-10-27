const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore, createMongoStore } = require('../src/store');

// Bộ test chung cho mọi store. Mongo chỉ chạy khi có MONGODB_TEST_URI.
function storeSuite(name, makeStore) {
  const d = (s) => new Date(s);

  test(`${name}: insertAccess + updateAccess + listAccess moi nhat truoc`, async () => {
    const store = await makeStore();
    const a = await store.insertAccess({ unlockedAt: d('2026-10-27T08:00:00'), method: 'OTP', status: 'IN_PROGRESS', anomalies: [] });
    await store.insertAccess({ unlockedAt: d('2026-10-27T09:00:00'), method: 'REMOTE', status: 'DONE', anomalies: [] });
    await store.updateAccess(a, { status: 'DONE', openDurationSec: 12 });
    const { items, total } = await store.listAccess({});
    assert.equal(total, 2);
    assert.equal(items[0].method, 'REMOTE');
    assert.equal(items[1].openDurationSec, 12);
    assert.equal(typeof items[1].id, 'string');
    await store.close();
  });

  test(`${name}: listAccess loc theo ngay va method, phan trang`, async () => {
    const store = await makeStore();
    for (let i = 0; i < 5; i++) {
      await store.insertAccess({ unlockedAt: d(`2026-10-2${i}T10:00:00`), method: i % 2 ? 'REMOTE' : 'OTP', status: 'DONE', anomalies: [] });
    }
    const r1 = await store.listAccess({ from: d('2026-10-21T00:00:00'), to: d('2026-10-23T23:59:59') });
    assert.equal(r1.total, 3);
    const r2 = await store.listAccess({ method: 'OTP' });
    assert.equal(r2.total, 3);
    const r3 = await store.listAccess({ page: 2, pageSize: 2 });
    assert.equal(r3.items.length, 2);
    assert.equal(r3.items[0].unlockedAt.getDate(), 22);
    await store.close();
  });

  test(`${name}: anomalies - them, loc chua xu ly, resolve, dem`, async () => {
    const store = await makeStore();
    const id1 = await store.insertAnomaly({ type: 'TAMPER', severity: 'CRITICAL', message: 'x', at: d('2026-10-27T08:00:00'), accessLogId: null, resolved: false, resolvedAt: null });
    await store.insertAnomaly({ type: 'DOOR_AJAR', severity: 'WARN', message: 'y', at: d('2026-10-27T09:00:00'), accessLogId: null, resolved: false, resolvedAt: null });
    assert.equal(await store.countUnresolved(), 2);
    assert.equal(await store.resolveAnomaly(id1), true);
    assert.equal(await store.countUnresolved(), 1);
    const open = await store.listAnomalies({ resolved: false });
    assert.deepEqual(open.items.map((a) => a.type), ['DOOR_AJAR']);
    const all = await store.listAnomalies({});
    assert.equal(all.total, 2);
    assert.ok(all.items.find((a) => a.type === 'TAMPER').resolvedAt instanceof Date);
    await store.close();
  });

  test(`${name}: resolveAnomaly id khong ton tai / sai dinh dang -> false`, async () => {
    const store = await makeStore();
    assert.equal(await store.resolveAnomaly('khong-co'), false);
    assert.equal(await store.resolveAnomaly('0123456789abcdef01234567'), false);
    await store.close();
  });

  test(`${name}: insertAnomaly gan voi access log`, async () => {
    const store = await makeStore();
    const a = await store.insertAccess({ unlockedAt: d('2026-10-27T08:00:00'), method: 'OTP', status: 'DONE', anomalies: [] });
    await store.insertAnomaly({ type: 'AFTER_HOURS', severity: 'WARN', message: 'z', at: d('2026-10-27T08:00:00'), accessLogId: a, resolved: false, resolvedAt: null });
    const { items } = await store.listAnomalies({});
    assert.equal(items[0].accessLogId, a);
    await store.close();
  });
}

storeSuite('memory', async () => createMemoryStore());

const MONGO = process.env.MONGODB_TEST_URI;
if (MONGO) {
  storeSuite('mongo', async () => {
    const store = createMongoStore(MONGO);
    await store.ready();
    await store._dropAll();
    return store;
  });
}

test('memory: isConnected luon true', () => {
  assert.equal(createMemoryStore().isConnected(), true);
});
