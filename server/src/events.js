// Nhật ký sự kiện dạng vòng (mới nhất đứng đầu) + thông báo khi thay đổi.

function createEventLog({ limit = 100 } = {}) {
  const entries = [];
  const listeners = [];

  function add(level, event, details = '') {
    entries.unshift({ ts: Date.now(), level, event, details });
    if (entries.length > limit) entries.pop();
    console.log(`[${level}] ${event}${details ? ' - ' + details : ''}`);
    listeners.forEach((fn) => fn());
  }

  return {
    add,
    list: () => entries.slice(),
    onChange: (fn) => listeners.push(fn)
  };
}

module.exports = { createEventLog };
