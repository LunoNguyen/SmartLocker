const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStats } = require('../src/stats');

const NOW = new Date(2026, 9, 30, 15, 0, 0).getTime(); // 30/10/2026 15:00 giờ địa phương
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);

test('computeStats: dem theo ngay, theo gio, thoi luong mo trung binh', () => {
  const access = [
    { unlockedAt: at(30, 9), method: 'OTP', openDurationSec: 10, failedAttemptsBefore: 2 },
    { unlockedAt: at(30, 9, 30), method: 'REMOTE', openDurationSec: 20 },
    { unlockedAt: at(28, 23), method: 'OTP', openDurationSec: null },
    { unlockedAt: at(20, 10), method: 'OTP', openDurationSec: 99 } // ngoài 7 ngày
  ];
  const anomalies = [
    { type: 'TAMPER', severity: 'CRITICAL', at: at(29, 2), resolved: false },
    { type: 'DOOR_AJAR', severity: 'WARN', at: at(30, 9), resolved: true },
    { type: 'DOOR_AJAR', severity: 'WARN', at: at(1, 9), resolved: false } // ngoài 7 ngày
  ];
  const s = computeStats({ access, anomalies, days: 7, now: NOW });

  assert.equal(s.byDay.length, 7);
  assert.equal(s.byDay[0].day, '2026-10-24');
  assert.deepEqual(s.byDay[6], { day: '2026-10-30', OTP: 1, REMOTE: 1 });
  assert.deepEqual(s.byDay[4], { day: '2026-10-28', OTP: 1, REMOTE: 0 });
  assert.equal(s.byHour[9], 2);
  assert.equal(s.byHour[23], 1);
  assert.deepEqual(s.totals, {
    unlocks: 3, otp: 2, remote: 1, avgOpenSec: 15, maxOpenSec: 20, failedAttempts: 2,
    anomalies: 2, critical: 1, unresolved: 1
  });
  assert.deepEqual(s.anomaliesByType, { TAMPER: 1, DOOR_AJAR: 1 });
});

test('computeStats: khong co du lieu -> so 0, thoi luong null', () => {
  const s = computeStats({ access: [], anomalies: [], days: 3, now: NOW });
  assert.equal(s.totals.unlocks, 0);
  assert.equal(s.totals.avgOpenSec, null);
  assert.equal(s.byDay.length, 3);
});
