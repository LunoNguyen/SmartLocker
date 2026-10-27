// Ghép các sự kiện của tủ thành "phiên mở khóa" và phát hiện bất thường.
// Logic thuần: now() tiêm vào, ghi qua store (memory hoặc MongoDB).
// Mọi thao tác ghi được xếp hàng tuần tự; lỗi store chỉ ghi log, không làm hỏng luồng OTP.

const DEFAULT_CONFIG = {
  doorAjarSec: 60,
  afterHoursStart: 23,
  afterHoursEnd: 5,
  frequentCount: 5,
  frequentWindowMin: 10,
  offlineAlertMin: 2
};

const LOCK_REASONS = { DOOR_CLOSED: 'DOOR_CLOSED', TIMEOUT: 'TIMEOUT' };

function createAccessTracker({ store, now = Date.now, config = {}, onChange = () => {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let queue = Promise.resolve();

  let session = null;          // { id, data, ajarAlerted }
  let failStreak = 0;          // số lần nhập sai liên tiếp kể từ lần đúng gần nhất
  let failsBeforeUnlock = 0;   // chốt lại khi web xác nhận mã đúng, dùng cho UNLOCKED kế tiếp
  let unlockTimes = [];
  let lastFrequentAt = null;
  let offlineSince = null;
  let offlineAlerted = false;

  const date = () => new Date(now());

  function enqueue(fn) {
    queue = queue.then(fn).catch((err) => console.warn(`[NHẬT KÝ] Không ghi được: ${err.message}`));
  }

  function updateSession(s, fields) {
    Object.assign(s.data, fields);
    enqueue(async () => {
      if (!s.id) return;
      await store.updateAccess(s.id, fields);
      onChange('access');
    });
  }

  function raise(type, severity, message, linkSession = null) {
    const doc = { type, severity, message, at: date(), accessLogId: null, resolved: false, resolvedAt: null };
    if (linkSession) {
      linkSession.data.anomalies.push(type);
      const anomalies = [...linkSession.data.anomalies];
      enqueue(async () => {
        if (linkSession.id) await store.updateAccess(linkSession.id, { anomalies });
      });
    }
    enqueue(async () => {
      if (linkSession) doc.accessLogId = linkSession.id;
      doc.id = await store.insertAnomaly(doc);
      onChange('anomaly', { ...doc });
    });
  }

  function isAfterHours(d) {
    const h = d.getHours();
    const { afterHoursStart: s, afterHoursEnd: e } = cfg;
    return s > e ? h >= s || h < e : h >= s && h < e;
  }

  function closeSession(reason) {
    if (!session) return;
    updateSession(session, { lockedAt: date(), lockReason: reason, status: 'DONE' });
    session = null;
  }

  function startSession(method) {
    closeSession('UNKNOWN');  // phiên trước bị lỡ sự kiện LOCKED
    const s = {
      id: null,
      ajarAlerted: false,
      data: {
        unlockedAt: date(),
        method,
        failedAttemptsBefore: method === 'OTP' ? failsBeforeUnlock : 0,
        doorOpenedAt: null,
        doorClosedAt: null,
        openDurationSec: null,
        lockedAt: null,
        lockReason: null,
        status: 'IN_PROGRESS',
        anomalies: []
      }
    };
    failsBeforeUnlock = 0;
    session = s;
    const initial = { ...s.data, anomalies: [] };
    enqueue(async () => {
      s.id = await store.insertAccess(initial);
      onChange('access');
    });

    if (isAfterHours(s.data.unlockedAt)) {
      const t = s.data.unlockedAt.toTimeString().slice(0, 5);
      raise('AFTER_HOURS', 'WARN', `Mở khóa ngoài giờ (${t})`, s);
    }

    const windowMs = cfg.frequentWindowMin * 60_000;
    unlockTimes = unlockTimes.filter((t) => now() - t < windowMs);
    unlockTimes.push(now());
    if (unlockTimes.length > cfg.frequentCount && (lastFrequentAt === null || now() - lastFrequentAt >= windowMs)) {
      lastFrequentAt = now();
      raise('FREQUENT_UNLOCK', 'WARN', `Mở khóa ${unlockTimes.length} lần trong ${cfg.frequentWindowMin} phút`, s);
    }
  }

  return {
    handleVerifyResult(r) {
      if (!r) return;
      if (r.ok) {
        failsBeforeUnlock = failStreak;
        failStreak = 0;
        return;
      }
      if (r.reason === 'WRONG' || r.lockStarted) failStreak++;
      if (r.lockStarted && r.critical) {
        raise('BRUTE_FORCE_LOCK', 'CRITICAL', 'Nhập sai OTP 5 lần – khóa bàn phím 5 phút và đổi mã');
      } else if (r.lockStarted) {
        raise('BRUTE_FORCE_WARN', 'WARN', 'Nhập sai OTP 3 lần liên tiếp – khóa bàn phím 30 giây');
      }
    },

    handleEvent(event, source) {
      switch (event) {
        case 'UNLOCKED':
          startSession(source === 'REMOTE' ? 'REMOTE' : 'OTP');
          break;
        case 'DOOR_OPENED':
          if (session && !session.data.doorOpenedAt) updateSession(session, { doorOpenedAt: date() });
          break;
        case 'DOOR_CLOSED':
          if (session && session.data.doorOpenedAt && !session.data.doorClosedAt) {
            const closed = date();
            updateSession(session, {
              doorClosedAt: closed,
              openDurationSec: Math.round((closed - session.data.doorOpenedAt) / 1000)
            });
          }
          break;
        case 'LOCKED':
          closeSession(LOCK_REASONS[source] || 'UNKNOWN');
          break;
        case 'TAMPER':
          raise('TAMPER', 'CRITICAL', 'Cửa bị mở khi tủ đang khóa – nghi cạy cửa');
          break;
        default:
          break;
      }
    },

    handleStatus(online) {
      if (online) {
        offlineSince = null;
      } else if (offlineSince === null) {
        offlineSince = now();
        offlineAlerted = false;
      }
    },

    // Gọi mỗi giây: kiểm tra các bất thường theo thời gian
    tick() {
      const s = session;
      if (s && s.data.doorOpenedAt && !s.data.doorClosedAt && !s.ajarAlerted &&
          now() - s.data.doorOpenedAt.getTime() >= cfg.doorAjarSec * 1000) {
        s.ajarAlerted = true;
        raise('DOOR_AJAR', 'WARN', `Cửa mở quá ${cfg.doorAjarSec} giây`, s);
      }
      if (offlineSince !== null && !offlineAlerted && now() - offlineSince >= cfg.offlineAlertMin * 60_000) {
        offlineAlerted = true;
        raise('LOCKER_OFFLINE', 'WARN', `Tủ mất kết nối hơn ${cfg.offlineAlertMin} phút`);
      }
    },

    flush: () => queue
  };
}

module.exports = { createAccessTracker, DEFAULT_CONFIG };
