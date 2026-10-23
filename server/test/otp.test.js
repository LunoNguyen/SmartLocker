const test = require('node:test');
const assert = require('node:assert/strict');
const { createOtpService } = require('../src/otp');

// Dong ho gia + bo sinh so gia tra lan luot tung gia tri trong mang
function setup(codes, ttlMs = 600000) {
  const clock = { t: 1_000_000 };
  const queue = [...codes];
  const s = createOtpService({
    ttlMs,
    now: () => clock.t,
    random: () => {
      if (queue.length === 0) throw new Error('het ma gia');
      return queue.shift();
    }
  });
  return { s, clock };
}

test('sinh ma 6 so co dem 0 o dau', () => {
  const { s } = setup([4817]);
  assert.equal(s.getState().code, '004817');
});

test('ma moi co han dung ttl', () => {
  const { s, clock } = setup([123456]);
  assert.equal(s.getState().createdAt, clock.t);
  assert.equal(s.getState().expiresAt, clock.t + 600000);
});

test('ma bat dau bang 0 nhap dung van duoc chap nhan', () => {
  const { s } = setup([4817, 999999]);
  assert.equal(s.verify('r1', '004817').ok, true);
});

test('dung ma -> ok, ma cu het dung, ma moi sinh ngay', () => {
  const { s, clock } = setup([111111, 222222]);
  assert.deepEqual(s.verify('r1', '111111'), { ok: true, rotated: true });
  assert.equal(s.getState().code, '222222');
  assert.deepEqual(s.getState().lastUsed, { code: '111111', at: clock.t });
  assert.equal(s.getState().expiresAt, clock.t + 600000);
  assert.equal(s.verify('r2', '111111').reason, 'WRONG');
});

test('sai 1, 2 -> attempts_left 2, 1; sai 3 -> khoa 30s', () => {
  const { s } = setup([111111]);
  assert.deepEqual(s.verify('a', '000000'), { ok: false, reason: 'WRONG', attempts_left: 2 });
  assert.deepEqual(s.verify('b', '000000'), { ok: false, reason: 'WRONG', attempts_left: 1 });
  assert.deepEqual(s.verify('c', '000000'), { ok: false, reason: 'LOCKED_OUT', retry_in: 30 });
});

test('dang khoa -> LOCKED_OUT ke ca khi nhap dung, retry_in lam tron len', () => {
  const { s, clock } = setup([111111]);
  for (const r of ['a', 'b', 'c']) s.verify(r, '000000');
  clock.t += 10_500;
  assert.deepEqual(s.verify('d', '111111'), { ok: false, reason: 'LOCKED_OUT', retry_in: 20 });
  assert.equal(s.getState().code, '111111');
});

test('het khoa 30s, sai lan 4 -> attempts_left 1; lan 5 -> khoa 300s, doi ma, critical, reset dem', () => {
  const { s, clock } = setup([111111, 333333]);
  for (const r of ['a', 'b', 'c']) s.verify(r, '000000');
  clock.t += 30_000;
  assert.deepEqual(s.verify('d', '000000'), { ok: false, reason: 'WRONG', attempts_left: 1 });
  assert.deepEqual(s.verify('e', '000000'), { ok: false, reason: 'LOCKED_OUT', retry_in: 300, critical: true });
  assert.equal(s.getState().code, '333333');
  assert.equal(s.getState().failCount, 0);
  assert.equal(s.getState().lockedUntil, clock.t + 300_000);
});

test('dung ma reset failCount', () => {
  const { s } = setup([111111, 222222]);
  s.verify('a', '000000');
  s.verify('b', '000000');
  s.verify('c', '111111');
  assert.equal(s.getState().failCount, 0);
  assert.deepEqual(s.verify('d', '000000'), { ok: false, reason: 'WRONG', attempts_left: 2 });
});

test('het han -> tick doi ma va tra true; chua het han -> false', () => {
  const { s, clock } = setup([111111, 222222]);
  assert.equal(s.tick(), false);
  clock.t += 600_000;
  assert.equal(s.tick(), true);
  assert.equal(s.getState().code, '222222');
});

test('ma vua het han khi nhap -> WRONG', () => {
  const { s, clock } = setup([111111, 222222]);
  clock.t += 600_000;
  assert.equal(s.verify('a', '111111').reason, 'WRONG');
});

test('req trung trong 50 req gan nhat -> null, khong tinh lan sai', () => {
  const { s } = setup([111111]);
  s.verify('dup', '000000');
  assert.equal(s.verify('dup', '000000'), null);
  assert.equal(s.getState().failCount, 1);
});

test('code sai dinh dang -> INVALID, khong tang failCount', () => {
  const { s } = setup([111111]);
  const bad = [482913, '48291', '4829130', 'abcdef', undefined, null, ' 11111'];
  bad.forEach((code, i) => {
    assert.deepEqual(s.verify('x' + i, code), { ok: false, reason: 'INVALID' });
  });
  assert.equal(s.getState().failCount, 0);
});

test('req thieu hoac khong phai chuoi -> INVALID', () => {
  const { s } = setup([111111]);
  assert.deepEqual(s.verify(undefined, '111111'), { ok: false, reason: 'INVALID' });
  assert.deepEqual(s.verify('', '111111'), { ok: false, reason: 'INVALID' });
  assert.equal(s.getState().code, '111111');
});

test('revoke -> NO_OTP, tick khong sinh lai; rotate -> co ma moi', () => {
  const { s, clock } = setup([111111, 222222]);
  s.revoke();
  assert.equal(s.getState().code, null);
  assert.equal(s.getState().expiresAt, null);
  assert.deepEqual(s.verify('a', '111111'), { ok: false, reason: 'NO_OTP' });
  clock.t += 700_000;
  assert.equal(s.tick(), false);
  s.rotate();
  assert.equal(s.getState().code, '222222');
});

test('NO_OTP khong tinh lan sai', () => {
  const { s } = setup([111111]);
  s.revoke();
  s.verify('a', '000000');
  assert.equal(s.getState().failCount, 0);
});

test('clearLockout -> verify duoc ngay', () => {
  const { s } = setup([111111, 222222]);
  for (const r of ['a', 'b', 'c']) s.verify(r, '000000');
  s.clearLockout();
  assert.equal(s.getState().lockedUntil, 0);
  assert.equal(s.getState().failCount, 0);
  assert.equal(s.verify('d', '111111').ok, true);
});

test('mac dinh dung crypto.randomInt va ttl 10 phut', () => {
  const s = createOtpService();
  const st = s.getState();
  assert.match(st.code, /^\d{6}$/);
  assert.equal(st.expiresAt - st.createdAt, 600000);
});
