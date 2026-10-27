// Express app: API OTP + SSE + nhật ký/bất thường. Nhận mọi dependency từ ngoài để test được.

const path = require('path');
const express = require('express');

const METHOD_LABEL = { OTP: 'Nhập OTP', REMOTE: 'Mở từ xa' };
const LOCK_LABEL = { DOOR_CLOSED: 'Đóng cửa', TIMEOUT: 'Hết giờ, không mở cửa', UNKNOWN: 'Không rõ' };
const ANOMALY_LABEL = {
  TAMPER: 'Cạy cửa',
  BRUTE_FORCE_WARN: 'Dò mã (khóa 30s)',
  BRUTE_FORCE_LOCK: 'Dò mã (khóa 5 phút)',
  DOOR_AJAR: 'Cửa mở quá lâu',
  AFTER_HOURS: 'Mở ngoài giờ',
  FREQUENT_UNLOCK: 'Mở quá nhiều lần',
  LOCKER_OFFLINE: 'Tủ mất kết nối'
};

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => (d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '');
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

class BadRequest extends Error {}

// 'YYYY-MM-DD' -> Date giờ địa phương (đầu ngày hoặc cuối ngày)
function parseDay(value, endOfDay) {
  if (value === undefined || value === '') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new BadRequest('Ngày phải có dạng YYYY-MM-DD');
  const d = endOfDay ? new Date(+m[1], m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) throw new BadRequest('Ngày không hợp lệ');
  return d;
}

function accessFilter(q) {
  if (q.method && !METHOD_LABEL[q.method]) throw new BadRequest('method phải là OTP hoặc REMOTE');
  return { from: parseDay(q.from, false), to: parseDay(q.to, true), method: q.method || undefined };
}

function createApp({ otp, log, bridge, store, mqttUrl }) {
  const stats = { unresolved: 0 };
  let logsVersion = 0;
  const sseClients = new Set();

  function snapshot() {
    return {
      otp: otp.getState(),
      locker: bridge.getLocker(),
      broker: { connected: bridge.isBrokerConnected(), url: mqttUrl },
      db: { connected: store.isConnected() },
      anomalies: { unresolved: stats.unresolved },
      logsVersion,
      log: log.list(),
      serverTime: Date.now()
    };
  }

  function broadcast() {
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    sseClients.forEach((res) => res.write(msg));
  }

  async function refreshStats() {
    try {
      stats.unresolved = await store.countUnresolved();
    } catch {
      // MongoDB tắt: giữ số cũ, thanh cảnh báo DB sẽ hiện trên web
    }
    broadcast();
  }

  async function notifyLogsChanged() {
    logsVersion++;
    await refreshStats();
  }

  // Bọc handler async: lỗi nhập -> 400, DB tắt -> 503
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
      res.status(503).json({ error: 'Không truy vấn được MongoDB: ' + err.message });
    }
  };

  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- Trạng thái & OTP ---
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

  // --- Nhật ký mở khóa ---
  app.get('/api/access-logs', handle(async (req, res) => {
    const filter = accessFilter(req.query);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = 20;
    const { items, total } = await store.listAccess({ ...filter, page, pageSize });
    res.json({ items, total, page, pageSize });
  }));

  app.get('/api/access-logs.csv', handle(async (req, res) => {
    const filter = accessFilter(req.query);
    const { items } = await store.listAccess({ ...filter, page: 1, pageSize: 5000 });
    const header = ['Thời điểm mở khóa', 'Cách mở', 'Số lần sai trước đó', 'Mở cửa lúc', 'Đóng cửa lúc',
      'Thời lượng mở cửa (giây)', 'Khóa lại lúc', 'Cách khóa lại', 'Bất thường'];
    const rows = items.map((a) => [
      fmtDate(a.unlockedAt), METHOD_LABEL[a.method] || a.method, a.failedAttemptsBefore ?? '',
      fmtDate(a.doorOpenedAt), fmtDate(a.doorClosedAt), a.openDurationSec ?? '',
      fmtDate(a.lockedAt), LOCK_LABEL[a.lockReason] || (a.status === 'IN_PROGRESS' ? 'Đang mở' : ''),
      (a.anomalies || []).map((t) => ANOMALY_LABEL[t] || t).join('; ')
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const today = new Date();
    const name = `nhat-ky-mo-khoa-${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}.csv`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    res.send('﻿' + csv);
  }));

  // --- Bất thường ---
  app.get('/api/anomalies', handle(async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const resolved = req.query.status === 'all' ? undefined : req.query.status === 'resolved' ? true : req.query.status === 'open' ? false : undefined;
    const { items, total } = await store.listAnomalies({ resolved, page, pageSize: 20 });
    res.json({ items, total, page, pageSize: 20 });
  }));

  app.post('/api/anomalies/:id/resolve', handle(async (req, res) => {
    if (!(await store.resolveAnomaly(req.params.id))) {
      return res.status(404).json({ error: 'Không tìm thấy hoặc đã xử lý rồi' });
    }
    log.add('INFO', 'ANOMALY_RESOLVED', 'Admin đánh dấu đã xử lý một bất thường');
    await notifyLogsChanged();
    res.json(snapshot());
  }));

  return { app, broadcast, refreshStats, notifyLogsChanged };
}

module.exports = { createApp, ANOMALY_LABEL };
