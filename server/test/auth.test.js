const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, parseUsers } = require('../src/auth');
const { createApp } = require('../src/app');
const { createOtpService } = require('../src/otp');
const { createEventLog } = require('../src/events');
const { createMemoryStore } = require('../src/store');

const SECRET = 'test-secret-0123456789abcdef';
const USERS = 'admin:admin123:admin,cudan:cudan123:resident';

function makeAuth(opts = {}) {
  return createAuth({ users: parseUsers(USERS), secret: SECRET, ...opts });
}

test('parseUsers: bam mat khau, khong giu ban ro; sai dinh dang -> loi', () => {
  const users = parseUsers(USERS);
  assert.equal(users.length, 2);
  assert.equal(users[1].role, 'resident');
  assert.ok(!JSON.stringify(users).includes('cudan123'));
  assert.throws(() => parseUsers('admin:x:root'), /AUTH_USERS/);
  assert.throws(() => parseUsers('op:x:operator'), /AUTH_USERS/); // vai trò cũ không còn
  assert.throws(() => parseUsers('admin::admin'), /AUTH_USERS/);
});

test('login dung -> token JWT 3 phan, verify ra sub/role', () => {
  const auth = makeAuth();
  const r = auth.login('cudan', 'cudan123');
  assert.equal(r.token.split('.').length, 3);
  const p = auth.verify(r.token);
  assert.equal(p.sub, 'cudan');
  assert.equal(p.role, 'resident');
});

test('login sai -> 401; sai qua 5 lan cung IP -> 429', () => {
  const auth = makeAuth();
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login('admin', 'sai', '1.2.3.4'), (e) => e.status === 401);
  assert.throws(() => auth.login('admin', 'admin123', '1.2.3.4'), (e) => e.status === 429);
  assert.ok(auth.login('admin', 'admin123', '5.6.7.8').token); // IP khác không bị chặn
});

test('token bi sua payload hoac sai chu ky -> null', () => {
  const auth = makeAuth();
  const [h, , s] = auth.login('cudan', 'cudan123').token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'cudan', role: 'admin', exp: 9e9 })).toString('base64url');
  assert.equal(auth.verify(`${h}.${forged}.${s}`), null);
  const other = createAuth({ users: [], secret: 'another-secret-0123456789' });
  assert.equal(auth.verify(other.sign({ sub: 'x', role: 'admin', exp: 9e9 })), null);
  assert.equal(auth.verify('abc'), null);
});

test('token het han -> null; alg none -> null', () => {
  let t = 1_000_000;
  const auth = makeAuth({ now: () => t, ttlSec: 60 });
  const { token } = auth.login('admin', 'admin123');
  t += 61_000;
  assert.equal(auth.verify(token), null);
  const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = token.split('.')[1];
  assert.equal(auth.verify(`${none}.${body}.`), null);
});

// ---------------------------------------------------------------------------
// API có bật đăng nhập

const fakeBridge = () => ({
  sent: 0,
  getLocker: () => ({ online: true, lock: 'LOCKED', door: 'CLOSED' }),
  isBrokerConnected: () => true,
  sendUnlock() { this.sent++; return true; },
  onChange() {}
});

async function start() {
  const bridge = fakeBridge();
  const otp = createOtpService();
  const ctx = createApp({ otp, log: createEventLog(), bridge, store: createMemoryStore(), mqttUrl: 'mqtt://x', auth: makeAuth() });
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, { token, body } = {}) => fetch(base + p, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body)
  });
  const login = async (u, pw) => (await (await call('POST', '/api/auth/login', { body: { username: u, password: pw } })).json()).token;
  return { otp, bridge, call, login, close: () => new Promise((r) => server.close(r)) };
}

test('API: chua dang nhap -> 401, trang tinh van mo', async () => {
  const s = await start();
  assert.equal((await s.call('GET', '/api/state')).status, 401);
  assert.equal((await s.call('POST', '/api/unlock')).status, 401);
  assert.equal((await s.call('GET', '/index.html')).status, 200);
  await s.close();
});

test('API: login dat cookie HttpOnly SameSite=Strict, dung cookie goi duoc API', async () => {
  const s = await start();
  const res = await s.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /sl_token=.+; HttpOnly; SameSite=Strict/);
  const st = await s.call('GET', '/api/auth/me');
  assert.equal(st.status, 401);
  const me = await fetch(res.url.replace('/api/auth/login', '/api/auth/me'), { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal((await me.json()).user.role, 'admin');
  await s.close();
});

test('API: cu dan thay ma OTP, tao ma moi, mo khoa tu xa, xem nhat ky / thong ke', async () => {
  const s = await start();
  const token = await s.login('cudan', 'cudan123');
  const st = await (await s.call('GET', '/api/state', { token })).json();
  assert.equal(st.otp.code, s.otp.getState().code);
  assert.equal((await s.call('POST', '/api/otp/rotate', { token })).status, 200);
  assert.equal((await s.call('POST', '/api/unlock', { token })).status, 200);
  assert.equal(s.bridge.sent, 1);
  assert.equal((await s.call('GET', '/api/access-logs', { token })).status, 200);
  assert.equal((await s.call('GET', '/api/stats', { token })).status, 200);
  await s.close();
});

test('API: cu dan khong huy ma / go khoa / xuat CSV / xu ly bat thuong duoc', async () => {
  const s = await start();
  const token = await s.login('cudan', 'cudan123');
  assert.equal((await s.call('POST', '/api/otp/revoke', { token })).status, 403);
  assert.equal((await s.call('POST', '/api/lockout/clear', { token })).status, 403);
  assert.equal((await s.call('GET', '/api/access-logs.csv', { token })).status, 403);
  assert.equal((await s.call('POST', '/api/anomalies/x/resolve', { token })).status, 403);
  await s.close();
});

test('API: admin lam duoc moi thao tac', async () => {
  const s = await start();
  const token = await s.login('admin', 'admin123');
  assert.equal((await s.call('POST', '/api/otp/revoke', { token })).status, 200);
  assert.equal((await s.call('POST', '/api/lockout/clear', { token })).status, 200);
  assert.equal((await s.call('GET', '/api/access-logs.csv', { token })).status, 200);
  await s.close();
});

test('API: header bao mat co mat', async () => {
  const s = await start();
  const res = await s.call('GET', '/index.html');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-powered-by'), null);
  await s.close();
});
