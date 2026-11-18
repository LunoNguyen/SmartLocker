// Tính số liệu cho tab Thống kê từ nhật ký mở khóa và bất thường (giờ địa phương của server).

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Mốc 0h của ngày đầu tiên trong cửa sổ `days` ngày tính tới hôm nay
function windowStart(days, now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1));
}

function computeStats({ access, anomalies, days, now = Date.now() }) {
  const start = windowStart(days, now);
  const byDay = [];
  const index = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const row = { day: dayKey(d), OTP: 0, REMOTE: 0 };
    index.set(row.day, row);
    byDay.push(row);
  }

  const byHour = new Array(24).fill(0);
  const durations = [];
  let failedBefore = 0;
  for (const a of access) {
    const t = new Date(a.unlockedAt);
    if (t < start) continue;
    const row = index.get(dayKey(t));
    if (row && (a.method === 'OTP' || a.method === 'REMOTE')) row[a.method]++;
    byHour[t.getHours()]++;
    if (typeof a.openDurationSec === 'number') durations.push(a.openDurationSec);
    failedBefore += a.failedAttemptsBefore || 0;
  }

  const anomaliesByType = {};
  let critical = 0;
  let unresolved = 0;
  for (const x of anomalies) {
    if (new Date(x.at) < start) continue;
    anomaliesByType[x.type] = (anomaliesByType[x.type] || 0) + 1;
    if (x.severity === 'CRITICAL') critical++;
    if (!x.resolved) unresolved++;
  }

  const total = byDay.reduce((s, r) => s + r.OTP + r.REMOTE, 0);
  const otpCount = byDay.reduce((s, r) => s + r.OTP, 0);
  return {
    days,
    from: start,
    totals: {
      unlocks: total,
      otp: otpCount,
      remote: total - otpCount,
      avgOpenSec: durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : null,
      maxOpenSec: durations.length ? Math.max(...durations) : null,
      failedAttempts: failedBefore,
      anomalies: Object.values(anomaliesByType).reduce((s, v) => s + v, 0),
      critical,
      unresolved
    },
    byDay,
    byHour,
    anomaliesByType
  };
}

module.exports = { computeStats, windowStart };
