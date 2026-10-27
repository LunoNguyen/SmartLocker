// Lưu nhật ký mở khóa và bất thường.
// createMemoryStore(): lưu trong RAM (test). createMongoStore(uri): MongoDB thật.
// Cả hai cùng giao diện; id trả ra luôn là chuỗi.

const { MongoClient, ObjectId } = require('mongodb');

const DEFAULT_PAGE_SIZE = 20;

function pageOf(page, pageSize) {
  const size = Math.min(Math.max(parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE, 1), 5000);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  return { skip: (p - 1) * size, size };
}

// ---------------------------------------------------------------------------
function createMemoryStore() {
  const access = [];
  const anomalies = [];
  let seq = 0;
  const nextId = () => String(++seq).padStart(24, '0');

  const byDateDesc = (field) => (a, b) => b[field] - a[field];
  const copy = (doc) => ({ ...doc, anomalies: doc.anomalies ? [...doc.anomalies] : doc.anomalies });

  return {
    isConnected: () => true,
    onConnectionChange() {},
    async ready() {},
    async close() {},

    async insertAccess(doc) {
      const id = nextId();
      access.push({ ...doc, id });
      return id;
    },
    async updateAccess(id, fields) {
      const doc = access.find((a) => a.id === id);
      if (doc) Object.assign(doc, fields);
    },
    async listAccess({ from, to, method, page, pageSize } = {}) {
      const { skip, size } = pageOf(page, pageSize);
      const list = access
        .filter((a) => (!from || a.unlockedAt >= from) && (!to || a.unlockedAt <= to) && (!method || a.method === method))
        .sort(byDateDesc('unlockedAt'));
      return { items: list.slice(skip, skip + size).map(copy), total: list.length };
    },

    async insertAnomaly(doc) {
      const id = nextId();
      anomalies.push({ ...doc, id });
      return id;
    },
    async listAnomalies({ resolved, page, pageSize } = {}) {
      const { skip, size } = pageOf(page, pageSize);
      const list = anomalies
        .filter((a) => resolved === undefined || a.resolved === resolved)
        .sort(byDateDesc('at'));
      return { items: list.slice(skip, skip + size).map((a) => ({ ...a })), total: list.length };
    },
    async resolveAnomaly(id) {
      const doc = anomalies.find((a) => a.id === id && !a.resolved);
      if (!doc) return false;
      doc.resolved = true;
      doc.resolvedAt = new Date();
      return true;
    },
    async countUnresolved() {
      return anomalies.filter((a) => !a.resolved).length;
    }
  };
}

// ---------------------------------------------------------------------------
function createMongoStore(uri, { pingIntervalMs = 5000 } = {}) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  const db = client.db();
  const accessCol = db.collection('access_logs');
  const anomalyCol = db.collection('anomalies');

  let connected = false;
  const listeners = [];
  const setConnected = (value) => {
    if (value === connected) return;
    connected = value;
    console.log(value ? `[MongoDB] Đã kết nối ${db.databaseName}` : '[MongoDB] Mất kết nối – nhật ký tạm không được lưu');
    listeners.forEach((fn) => fn(value));
  };

  async function ping() {
    try {
      await db.command({ ping: 1 });
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }
  const timer = setInterval(ping, pingIntervalMs);
  timer.unref();

  // Không chờ 2 s cho mỗi thao tác khi DB đang tắt
  function ensure() {
    if (!connected) throw new Error('MongoDB chưa kết nối');
  }

  const toObjectId = (id) => (ObjectId.isValid(id) && String(id).length === 24 ? new ObjectId(id) : null);
  const out = ({ _id, accessLogId, ...rest }) => ({
    id: String(_id),
    ...rest,
    ...(accessLogId !== undefined ? { accessLogId: accessLogId ? String(accessLogId) : null } : {})
  });

  return {
    isConnected: () => connected,
    onConnectionChange: (fn) => listeners.push(fn),
    ready: ping,
    async close() {
      clearInterval(timer);
      await client.close();
    },
    async _dropAll() {
      await accessCol.deleteMany({});
      await anomalyCol.deleteMany({});
    },

    async insertAccess(doc) {
      ensure();
      const r = await accessCol.insertOne({ ...doc });
      return String(r.insertedId);
    },
    async updateAccess(id, fields) {
      ensure();
      const _id = toObjectId(id);
      if (_id) await accessCol.updateOne({ _id }, { $set: fields });
    },
    async listAccess({ from, to, method, page, pageSize } = {}) {
      ensure();
      const { skip, size } = pageOf(page, pageSize);
      const q = {};
      if (from || to) q.unlockedAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
      if (method) q.method = method;
      const [items, total] = await Promise.all([
        accessCol.find(q).sort({ unlockedAt: -1 }).skip(skip).limit(size).toArray(),
        accessCol.countDocuments(q)
      ]);
      return { items: items.map(out), total };
    },

    async insertAnomaly(doc) {
      ensure();
      const r = await anomalyCol.insertOne({ ...doc, accessLogId: doc.accessLogId ? toObjectId(doc.accessLogId) : null });
      return String(r.insertedId);
    },
    async listAnomalies({ resolved, page, pageSize } = {}) {
      ensure();
      const { skip, size } = pageOf(page, pageSize);
      const q = resolved === undefined ? {} : { resolved };
      const [items, total] = await Promise.all([
        anomalyCol.find(q).sort({ at: -1 }).skip(skip).limit(size).toArray(),
        anomalyCol.countDocuments(q)
      ]);
      return { items: items.map(out), total };
    },
    async resolveAnomaly(id) {
      ensure();
      const _id = toObjectId(id);
      if (!_id) return false;
      const r = await anomalyCol.updateOne({ _id, resolved: false }, { $set: { resolved: true, resolvedAt: new Date() } });
      return r.modifiedCount === 1;
    },
    async countUnresolved() {
      ensure();
      return anomalyCol.countDocuments({ resolved: false });
    }
  };
}

module.exports = { createMemoryStore, createMongoStore };
