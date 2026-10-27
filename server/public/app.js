// Dashboard Smart Locker: nhận trạng thái qua SSE, tự đếm ngược ở trình duyệt.

const $ = (id) => document.getElementById(id);
let state = null;
let clockOffset = 0; // serverTime - Date.now() trên trình duyệt

const LEVEL_PILL = { INFO: 'neutral', SUCCESS: 'ok', WARN: 'warn', CRITICAL: 'bad' };
const LOCK_TEXT = { LOCKED: ['Đã khóa', 'ok'], UNLOCKED: ['Đang mở', 'warn'] };
const DOOR_TEXT = { CLOSED: ['Đóng', 'ok'], OPEN: ['Mở', 'warn'] };

const serverNow = () => Date.now() + clockOffset;
const pill = (text, kind) => `<span class="pill ${kind}">${text}</span>`;
const hhmm = (ts) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function render() {
  if (!state) return;
  const { otp, locker, broker } = state;

  // Broker
  $('broker-banner').hidden = broker.connected;
  $('broker-dot').className = 'dot ' + (broker.connected ? 'on' : 'off');
  $('broker-text').textContent = broker.connected ? 'Broker đã kết nối' : 'Mất kết nối broker';

  // OTP
  const codeEl = $('otp-code');
  if (otp.code) {
    codeEl.textContent = otp.code;
    codeEl.classList.remove('empty');
  } else {
    codeEl.textContent = 'Chưa có mã';
    codeEl.classList.add('empty');
  }
  $('btn-copy').disabled = !otp.code;
  $('btn-revoke').disabled = !otp.code;
  $('btn-rotate').classList.toggle('pulse', !otp.code);
  $('otp-last').innerHTML = otp.lastUsed
    ? `Mã <b>${otp.lastUsed.code}</b> đã dùng lúc ${hhmm(otp.lastUsed.at)} và bị hủy`
    : '&nbsp;';

  // Tủ
  $('st-online').innerHTML = locker.online ? pill('Online', 'ok') : pill('Offline', 'bad');
  const [lockText, lockKind] = own(LOCK_TEXT, locker.lock) || ['–', 'neutral'];
  const [doorText, doorKind] = own(DOOR_TEXT, locker.door) || ['–', 'neutral'];
  $('st-lock').innerHTML = pill(lockText, lockKind);
  $('st-door').innerHTML = pill(doorText, doorKind);
  $('btn-unlock').disabled = !locker.online || !broker.connected;

  // Bảo mật
  $('sec-fails').textContent = otp.failCount;

  // Nhật ký
  $('log').innerHTML = state.log.map((e) => `
    <li class="${e.level}">
      <time>${hhmm(e.ts)}</time>
      <span class="lvl">${pill(e.level, LEVEL_PILL[e.level] || 'neutral')}</span>
      <span><span class="ev">${escapeHtml(e.event)}</span> ${escapeHtml(e.details)}</span>
    </li>`).join('');

  tick();
}

// Cập nhật đồng hồ mỗi giây, không cần server gửi
function tick() {
  if (!state) return;
  const { otp } = state;
  const now = serverNow();

  if (otp.code && otp.expiresAt) {
    const total = otp.expiresAt - otp.createdAt;
    const left = Math.max(0, otp.expiresAt - now);
    const sec = Math.ceil(left / 1000);
    $('otp-bar').style.width = (left / total) * 100 + '%';
    $('otp-bar').classList.toggle('low', sec <= 60);
    $('otp-expire').textContent = `Tự đổi mã sau ${mmss(sec)}`;
  } else {
    $('otp-bar').style.width = '0';
    $('otp-expire').textContent = 'Bấm "Tạo mã mới" để cấp mã cho tủ';
  }

  const lockLeft = Math.ceil((otp.lockedUntil - now) / 1000);
  if (lockLeft > 0) {
    $('sec-lock').innerHTML = pill(`Bị khóa ${mmss(lockLeft)}`, 'bad');
    $('btn-clear').disabled = false;
  } else {
    $('sec-lock').innerHTML = pill('Bình thường', 'ok');
    $('btn-clear').disabled = otp.failCount === 0;
  }
}

// ---------------------------------------------------------------------------
// Tab nhật ký mở khóa & bất thường
const METHOD_TEXT = { OTP: 'Nhập OTP', REMOTE: 'Mở từ xa' };
const LOCK_REASON_TEXT = { DOOR_CLOSED: 'Đóng cửa', TIMEOUT: 'Hết giờ, không mở cửa', UNKNOWN: 'Không rõ' };
const ANOMALY_TEXT = {
  TAMPER: 'Cạy cửa',
  BRUTE_FORCE_WARN: 'Dò mã (khóa 30s)',
  BRUTE_FORCE_LOCK: 'Dò mã (khóa 5 phút)',
  DOOR_AJAR: 'Cửa mở quá lâu',
  AFTER_HOURS: 'Mở ngoài giờ',
  FREQUENT_UNLOCK: 'Mở quá nhiều lần',
  LOCKER_OFFLINE: 'Tủ mất kết nối'
};
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDateTime = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('vi-VN') : '–');
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);

let activeTab = 'control';
let seenLogsVersion = -1;
let lastUnresolved = null;
const logView = { page: 1, total: 0, pageSize: 20, filter: {} };
const anomalyView = { page: 1, total: 0, pageSize: 20 };

function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
  if (name === 'logs') loadLogs();
  if (name === 'anomalies') loadAnomalies();
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Lỗi ${res.status}`);
  return body;
}

function pagerText(view, el, prev, next) {
  const from = view.total ? (view.page - 1) * view.pageSize + 1 : 0;
  const to = Math.min(view.page * view.pageSize, view.total);
  el.textContent = view.total ? `${from}–${to} / ${view.total} bản ghi` : '';
  prev.disabled = view.page <= 1;
  next.disabled = to >= view.total;
}

function logQuery() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(logView.filter)) if (v) p.set(k, v);
  return p;
}

async function loadLogs() {
  const q = logQuery();
  $('csv-link').href = '/api/access-logs.csv?' + q;
  q.set('page', logView.page);
  const tbody = $('log-rows');
  try {
    const r = await fetchJson('/api/access-logs?' + q);
    Object.assign(logView, { total: r.total, pageSize: r.pageSize });
    tbody.innerHTML = r.items.length ? r.items.map((a) => {
      const anomalies = (a.anomalies || []).map((t) => pill(escapeHtml(own(ANOMALY_TEXT, t) || t), 'warn')).join('');
      const duration = a.openDurationSec === null || a.openDurationSec === undefined
        ? (a.status === 'IN_PROGRESS' && a.doorOpenedAt ? 'đang mở…' : '–')
        : `${a.openDurationSec} giây`;
      const lock = a.status === 'IN_PROGRESS'
        ? pill('Đang mở', 'warn')
        : `${fmtTime(a.lockedAt)} · ${escapeHtml(own(LOCK_REASON_TEXT, a.lockReason) || '–')}`;
      return `<tr class="${anomalies ? 'flagged' : ''}">
        <td>${fmtDateTime(a.unlockedAt)}</td>
        <td>${pill(escapeHtml(own(METHOD_TEXT, a.method) || a.method), a.method === 'REMOTE' ? 'neutral' : 'ok')}</td>
        <td class="num">${a.failedAttemptsBefore ?? '–'}</td>
        <td>${fmtTime(a.doorOpenedAt)}</td>
        <td>${fmtTime(a.doorClosedAt)}</td>
        <td class="num">${duration}</td>
        <td>${lock}</td>
        <td>${anomalies || '–'}</td>
      </tr>`;
    }).join('') : '<tr><td class="empty" colspan="8">Chưa có lần mở khóa nào trong khoảng này</td></tr>';
  } catch (err) {
    logView.total = 0;
    tbody.innerHTML = `<tr><td class="empty" colspan="8">${escapeHtml(err.message)}</td></tr>`;
  }
  pagerText(logView, $('log-summary'), $('log-prev'), $('log-next'));
}

async function loadAnomalies() {
  const status = $('anomaly-status').value;
  const list = $('anomaly-list');
  try {
    const r = await fetchJson(`/api/anomalies?status=${status}&page=${anomalyView.page}`);
    Object.assign(anomalyView, { total: r.total, pageSize: r.pageSize });
    list.innerHTML = r.items.length ? r.items.map((a) => `
      <li class="${a.resolved ? 'resolved' : escapeHtml(a.severity)}">
        ${pill(a.severity === 'CRITICAL' ? 'Nghiêm trọng' : 'Cảnh báo', a.resolved ? 'neutral' : a.severity === 'CRITICAL' ? 'bad' : 'warn')}
        <div>
          <div class="title">${escapeHtml(own(ANOMALY_TEXT, a.type) || a.type)}</div>
          <div class="meta">${fmtDateTime(a.at)} · ${escapeHtml(a.message)}${a.resolved ? ` · đã xử lý lúc ${fmtDateTime(a.resolvedAt)}` : ''}</div>
        </div>
        ${a.resolved ? '' : `<button class="btn" data-resolve="${escapeHtml(a.id)}">Đã xử lý</button>`}
      </li>`).join('')
      : `<li class="empty">${status === 'open' ? 'Không có bất thường nào chưa xử lý 🎉' : 'Chưa có bất thường nào'}</li>`;
  } catch (err) {
    anomalyView.total = 0;
    list.innerHTML = `<li class="empty">${escapeHtml(err.message)}</li>`;
  }
  pagerText(anomalyView, $('anomaly-summary'), $('anomaly-prev'), $('anomaly-next'));
}

function renderLogsMeta(s) {
  $('db-banner').hidden = s.db.connected;
  const n = s.anomalies.unresolved;
  $('anomaly-badge').hidden = n === 0;
  $('anomaly-badge').textContent = n;
  if (lastUnresolved !== null && n > lastUnresolved) toast('⚠️ Có bất thường mới – xem tab "Bất thường"');
  lastUnresolved = n;

  if (s.logsVersion !== seenLogsVersion) {
    seenLogsVersion = s.logsVersion;
    if (activeTab === 'logs') loadLogs();
    if (activeTab === 'anomalies') loadAnomalies();
  }
}

document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
$('log-filter').onsubmit = (e) => {
  e.preventDefault();
  logView.filter = Object.fromEntries(new FormData(e.target));
  logView.page = 1;
  loadLogs();
};
$('log-filter').onreset = () => {
  logView.filter = {};
  logView.page = 1;
  setTimeout(loadLogs);
};
$('log-prev').onclick = () => { logView.page--; loadLogs(); };
$('log-next').onclick = () => { logView.page++; loadLogs(); };
$('anomaly-status').onchange = () => { anomalyView.page = 1; loadAnomalies(); };
$('anomaly-prev').onclick = () => { anomalyView.page--; loadAnomalies(); };
$('anomaly-next').onclick = () => { anomalyView.page++; loadAnomalies(); };
$('anomaly-list').onclick = async (e) => {
  const id = e.target.dataset && e.target.dataset.resolve;
  if (!id) return;
  e.target.disabled = true;
  const res = await fetch(`/api/anomalies/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
  if (res.ok) {
    applyState(await res.json());
    toast('Đã đánh dấu xử lý');
  } else {
    toast('Không cập nhật được – kiểm tra MongoDB');
  }
  loadAnomalies();
};

function applyState(s) {
  state = s;
  clockOffset = s.serverTime - Date.now();
  render();
  renderLogsMeta(s);
}

async function loadState() {
  try {
    applyState(await (await fetch('/api/state')).json());
  } catch {
    $('broker-text').textContent = 'Không kết nối được web server';
    $('broker-dot').className = 'dot off';
  }
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => applyState(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    setTimeout(() => { loadState(); connectStream(); }, 2000);
  };
}

async function post(url, okMsg) {
  try {
    const res = await fetch(url, { method: 'POST' });
    applyState(await res.json());
    toast(res.ok ? okMsg : 'Không thực hiện được – kiểm tra kết nối broker');
  } catch {
    toast('Không gọi được web server');
  }
}

$('btn-rotate').onclick = () => post('/api/otp/rotate', 'Đã tạo mã OTP mới');
$('btn-revoke').onclick = () => {
  if (confirm('Hủy mã OTP hiện tại? Tủ sẽ không có mã cho tới khi bạn tạo mã mới.')) {
    post('/api/otp/revoke', 'Đã hủy mã OTP');
  }
};
$('btn-unlock').onclick = () => post('/api/unlock', 'Đã gửi lệnh mở khóa');
$('btn-clear').onclick = () => post('/api/lockout/clear', 'Đã gỡ khóa bàn phím');
$('btn-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.otp.code);
    toast('Đã copy mã');
  } catch {
    toast('Trình duyệt không cho copy');
  }
};

setInterval(tick, 1000);
loadState();
connectStream();
