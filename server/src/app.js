// Express app: API OTP + SSE + nhật ký/bất thường + thống kê. Nhận mọi dependency từ ngoài để test được.
// Có `auth` thì mọi API (trừ đăng nhập) cần JWT và phân quyền theo vai trò:
//   resident – cư dân chủ tủ: xem trạng thái, nhật ký, thống kê, xem mã OTP, tạo mã mới, mở khóa từ xa
//   admin    – thêm: hủy mã, gỡ khóa bàn phím, xử lý bất thường, xuất CSV

const path = require('path');
const express = require('express');
const { computeStats, windowStart } = require('./stats');

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

const FULL_ACCESS = { username: 'local', role: 'admin' }; // khi chạy không bật đăng nhập (test)

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

function createApp({ otp, log, bridge, store, mqttUrl, auth = null }) {
  const stats = { unresolved: 0 };
  let logsVersion = 0;
  const sseClients = new Set(); // { res, user }

  function snapshot(user = FULL_ACCESS) {
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
    sseClients.forEach(({ res, user }) => res.write(`data: ${JSON.stringify(snapshot(user))}\n\n`));
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
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.json({ limit: '10kb' }));

  // --- Đăng nhập ---
  const who = (req) => req.user || FULL_ACCESS;
  const actor = (req) => `${who(req).username} (${who(req).role})`;
  let can = () => (req, res, next) => next();

  if (auth) {
    app.post('/api/auth/login', (req, res) => {
      const { username, password } = req.body || {};
      try {
        const r = auth.login(username, password, req.ip);
        log.add('INFO', 'LOGIN', `${r.user.username} (${r.user.role}) đăng nhập`);
        res.set('Set-Cookie', auth.loginCookie(r.token));
        res.json(r);
      } catch (err) {
        if (!err.status) throw err;
        log.add('WARN', 'LOGIN_FAILED', `Đăng nhập thất bại với tên "${String(username || '').slice(0, 32)}" từ ${req.ip}`);
        res.status(err.status).json({ error: err.message });
      }
    });
    app.post('/api/auth/logout', (req, res) => {
      res.set('Set-Cookie', auth.logoutCookie());
      res.json({ ok: true });
    });
    app.use('/api', auth.authenticate);
    can = auth.requireRole;
  }

  app.get('/api/auth/me', (req, res) => res.json({ user: who(req), auth: !!auth }));

  // --- Trạng thái & OTP ---
  app.get('/api/state', (req, res) => res.json(snapshot(who(req))));

  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const client = { res, user: who(req) };
    res.write(`data: ${JSON.stringify(snapshot(client.user))}\n\n`);
    sseClients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(client);
    });
  });

  app.post('/api/otp/rotate', can('resident'), (req, res) => {
    otp.rotate();
    log.add('INFO', 'OTP_CREATED', `${actor(req)} tạo mã OTP mới`);
    res.json(snapshot(who(req)));
  });

  app.post('/api/otp/revoke', can('admin'), (req, res) => {
    otp.revoke();
    log.add('WARN', 'OTP_REVOKED', `${actor(req)} hủy mã OTP – tủ không có mã cho tới khi tạo mới`);
    res.json(snapshot(who(req)));
  });

  app.post('/api/lockout/clear', can('admin'), (req, res) => {
    otp.clearLockout();
    log.add('INFO', 'LOCKOUT_CLEARED', `${actor(req)} gỡ khóa bàn phím`);
    res.json(snapshot(who(req)));
  });

  app.post('/api/unlock', can('resident'), (req, res) => {
    if (!bridge.sendUnlock()) {
      log.add('WARN', 'REMOTE_UNLOCK_FAILED', 'Không gửi được lệnh mở: server mất kết nối broker');
      return res.status(503).json(snapshot(who(req)));
    }
    log.add('INFO', 'REMOTE_UNLOCK', `${actor(req)} gửi lệnh mở khóa từ xa`);
    res.json(snapshot(who(req)));
  });

  // --- Thống kê ---
  app.get('/api/stats', handle(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const from = windowStart(days);
    const [access, anomalies] = await Promise.all([
      store.listAccess({ from, page: 1, pageSize: 5000 }),
      store.listAnomalies({ from, page: 1, pageSize: 5000 })
    ]);
    res.json(computeStats({ access: access.items, anomalies: anomalies.items, days }));
  }));

  // --- Nhật ký mở khóa ---
  app.get('/api/access-logs', handle(async (req, res) => {
    const filter = accessFilter(req.query);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = 20;
    const { items, total } = await store.listAccess({ ...filter, page, pageSize });
    res.json({ items, total, page, pageSize });
  }));

  app.get('/api/access-logs.csv', can('admin'), handle(async (req, res) => {
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

  app.post('/api/anomalies/:id/resolve', can('admin'), handle(async (req, res) => {
    if (!(await store.resolveAnomaly(req.params.id))) {
      return res.status(404).json({ error: 'Không tìm thấy hoặc đã xử lý rồi' });
    }
    log.add('INFO', 'ANOMALY_RESOLVED', `${actor(req)} đánh dấu đã xử lý một bất thường`);
    await notifyLogsChanged();
    res.json(snapshot(who(req)));
  }));

  return { app, broadcast, refreshStats, notifyLogsChanged };
}

module.exports = { createApp, ANOMALY_LABEL };
