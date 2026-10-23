// Logic OTP thuần: sinh, xoay vòng, xác thực, chống dò mã.
// Không biết gì về MQTT/HTTP; now() và random() được tiêm vào để test.

const crypto = require('crypto');

const OTP_PATTERN = /^\d{6}$/;
const FIRST_LOCK_AT = 3;          // sai 3 lần -> khóa ngắn
const FIRST_LOCK_MS = 30_000;
const HARD_LOCK_AT = 5;           // sai 5 lần -> khóa dài + đổi mã
const HARD_LOCK_MS = 300_000;
const RECENT_REQ_LIMIT = 50;

function createOtpService({
  ttlMs = 600_000,
  now = Date.now,
  random = (max) => crypto.randomInt(0, max)
} = {}) {
  let code = null;
  let createdAt = null;
  let expiresAt = null;
  let lastUsed = null;
  let failCount = 0;
  let lockedUntil = 0;
  const recentReqs = [];

  function rotate() {
    code = String(random(1_000_000)).padStart(6, '0');
    createdAt = now();
    expiresAt = createdAt + ttlMs;
  }

  function revoke() {
    code = null;
    createdAt = null;
    expiresAt = null;
  }

  function tick() {
    if (code !== null && now() >= expiresAt) {
      rotate();
      return true;
    }
    return false;
  }

  function clearLockout() {
    lockedUntil = 0;
    failCount = 0;
  }

  function rememberReq(req) {
    if (recentReqs.includes(req)) return false;
    recentReqs.push(req);
    if (recentReqs.length > RECENT_REQ_LIMIT) recentReqs.shift();
    return true;
  }

  function lockedOut(extra = {}) {
    return { ok: false, reason: 'LOCKED_OUT', retry_in: Math.ceil((lockedUntil - now()) / 1000), ...extra };
  }

  function verify(req, input) {
    if (typeof req !== 'string' || req.length === 0) return { ok: false, reason: 'INVALID' };
    if (!rememberReq(req)) return null;
    if (typeof input !== 'string' || !OTP_PATTERN.test(input)) return { ok: false, reason: 'INVALID' };

    if (now() < lockedUntil) return lockedOut();

    tick();
    if (code === null) return { ok: false, reason: 'NO_OTP' };

    if (crypto.timingSafeEqual(Buffer.from(input), Buffer.from(code))) {
      lastUsed = { code, at: now() };
      failCount = 0;
      rotate();
      return { ok: true, rotated: true };
    }

    failCount++;
    if (failCount >= HARD_LOCK_AT) {
      lockedUntil = now() + HARD_LOCK_MS;
      failCount = 0;
      rotate();
      return lockedOut({ critical: true });
    }
    if (failCount === FIRST_LOCK_AT) {
      lockedUntil = now() + FIRST_LOCK_MS;
      return lockedOut();
    }
    const nextLimit = failCount < FIRST_LOCK_AT ? FIRST_LOCK_AT : HARD_LOCK_AT;
    return { ok: false, reason: 'WRONG', attempts_left: nextLimit - failCount };
  }

  function getState() {
    return { code, createdAt, expiresAt, lastUsed, failCount, lockedUntil };
  }

  rotate();
  return { getState, tick, rotate, revoke, clearLockout, verify };
}

module.exports = { createOtpService };
