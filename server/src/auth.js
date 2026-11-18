// Đăng nhập + phân quyền (RBAC) cho dashboard và API.
// Token JWT HS256 tự ký bằng crypto của Node (không cần thư viện ngoài).
// Trình duyệt giữ token trong cookie httpOnly (JS không đọc được); client khác dùng header Authorization: Bearer.

const crypto = require('crypto');

const ROLES = ['resident', 'admin']; // quyền tăng dần: cư dân chủ tủ < quản trị
const COOKIE = 'sl_token';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32) };
}

// "admin:admin123:admin,cudan:cudan123:resident" -> [{ username, role, salt, hash }]
function parseUsers(spec) {
  return String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [username, password, role] = entry.split(':');
      if (!username || !password || !ROLES.includes(role)) {
        throw new Error(`AUTH_USERS sai định dạng ở "${entry}" (cần user:mật_khẩu:resident|admin)`);
      }
      return { username, role, ...hashPassword(password) };
    });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createAuth({ users, secret, ttlSec = 8 * 3600, now = Date.now, maxFails = 5, failWindowMs = 5 * 60_000, secureCookie = false }) {
  if (!secret || secret.length < 16) throw new Error('JWT secret phải dài ít nhất 16 ký tự');
  const key = Buffer.from(secret);
  const byName = new Map(users.map((u) => [u.username, u]));
  const fails = new Map(); // ip -> { count, since }

  const hmac = (data) => crypto.createHmac('sha256', key).update(data).digest();

  function sign(payload) {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    return `${head}.${body}.${b64url(hmac(`${head}.${body}`))}`;
  }

  // Trả payload nếu chữ ký đúng và chưa hết hạn, ngược lại null
  function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts;
    try {
      if (JSON.parse(fromB64url(head)).alg !== 'HS256') return null;
      const expected = hmac(`${head}.${body}`);
      const given = fromB64url(sig);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
      const payload = JSON.parse(fromB64url(body));
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now()) return null;
      if (!ROLES.includes(payload.role)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function login(username, password, ip = '') {
    const f = fails.get(ip);
    if (f && now() - f.since < failWindowMs && f.count >= maxFails) {
      throw new AuthError(429, `Sai mật khẩu quá ${maxFails} lần, thử lại sau ${Math.ceil((f.since + failWindowMs - now()) / 1000)} giây`);
    }
    const user = byName.get(String(username || ''));
    // Luôn chạy scrypt kể cả khi sai user để thời gian phản hồi như nhau
    const { hash } = hashPassword(password, user ? user.salt : Buffer.alloc(16));
    if (!user || !crypto.timingSafeEqual(hash, user.hash)) {
      const cur = f && now() - f.since < failWindowMs ? f : { count: 0, since: now() };
      cur.count++;
      fails.set(ip, cur);
      throw new AuthError(401, 'Sai tên đăng nhập hoặc mật khẩu');
    }
    fails.delete(ip);
    const iat = Math.floor(now() / 1000);
    const token = sign({ sub: user.username, role: user.role, iat, exp: iat + ttlSec });
    return { token, user: { username: user.username, role: user.role }, expiresAt: (iat + ttlSec) * 1000 };
  }

  function tokenFrom(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7);
    return parseCookies(req.headers.cookie)[COOKIE];
  }

  function cookie(token, maxAgeSec) {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`;
  }

  return {
    sign,
    verify,
    login,
    loginCookie: (token) => cookie(token, ttlSec),
    logoutCookie: () => cookie('', 0),

    // Gắn req.user; thiếu/sai token -> 401
    authenticate(req, res, next) {
      const payload = verify(tokenFrom(req));
      if (!payload) return res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' });
      req.user = { username: payload.sub, role: payload.role };
      next();
    },

    // Chỉ cho vai trò >= role đi qua; không đủ quyền -> 403
    requireRole(role) {
      const min = ROLES.indexOf(role);
      return (req, res, next) => {
        if (ROLES.indexOf(req.user && req.user.role) >= min) return next();
        res.status(403).json({ error: `Cần quyền ${role} để thực hiện thao tác này` });
      };
    }
  };
}

module.exports = { createAuth, parseUsers, AuthError, ROLES };
