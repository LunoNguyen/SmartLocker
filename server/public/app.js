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
  const [lockText, lockKind] = LOCK_TEXT[locker.lock] || ['–', 'neutral'];
  const [doorText, doorKind] = DOOR_TEXT[locker.door] || ['–', 'neutral'];
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

function applyState(s) {
  state = s;
  clockOffset = s.serverTime - Date.now();
  render();
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
