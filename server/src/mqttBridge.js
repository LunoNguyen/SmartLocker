// Cầu nối MQTT <-> dịch vụ OTP.
// Nhận yêu cầu xác thực từ tủ, trả kết quả; theo dõi trạng thái và sự kiện của tủ.
// Không bao giờ publish mã OTP đang hiệu lực.

const VERIFY_LOG = {
  WRONG: ['WARN', 'OTP_WRONG', (r) => `Sai mã, còn ${r.attempts_left} lần trước khi bị khóa`],
  NO_OTP: ['WARN', 'OTP_NONE', () => 'Tủ gửi mã nhưng hiện không có mã OTP nào hiệu lực'],
  LOCKED_OUT: ['WARN', 'KEYPAD_LOCKED', (r) => `Bàn phím đang bị khóa, còn ${r.retry_in}s`]
};

const NO_TRACKER = { handleVerifyResult() {}, handleEvent() {}, handleStatus() {} };

const MAX_EVENT_AGE_MS = 24 * 3600_000;

function createMqttBridge({ client, otp, log, prefix = 'smartlocker/locker1/', tracker = NO_TRACKER, now = Date.now }) {
  let boot = null;
  let lastSeq = null;
  const topic = {
    verify: prefix + 'verify',
    result: prefix + 'verify/result',
    command: prefix + 'command',
    status: prefix + 'status',
    events: prefix + 'events'
  };
  const locker = { online: false, lock: 'UNKNOWN', door: 'UNKNOWN' };
  const listeners = [];
  const changed = () => listeners.forEach((fn) => fn());

  function parse(buf) {
    try {
      const data = JSON.parse(buf.toString());
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  function handleVerify(data) {
    const result = otp.verify(data.req, data.code);
    if (result === null) return; // req trùng: đã trả lời trước đó

    if (result.reason === 'INVALID') {
      log.add('WARN', 'INVALID_PAYLOAD', 'Yêu cầu xác thực sai định dạng (cần req và mã 6 chữ số)');
      return;
    }

    tracker.handleVerifyResult(result);
    const { rotated, critical, lockStarted, ...publicResult } = result;
    client.publish(topic.result, JSON.stringify({ req: data.req, ...publicResult }), { qos: 0, retain: false });

    if (result.ok) {
      log.add('SUCCESS', 'OTP_VERIFIED', 'Mã đúng → mở tủ. Mã đã bị hủy và mã mới đã được tạo');
    } else if (critical) {
      log.add('CRITICAL', 'BRUTE_FORCE', `Sai 5 lần liên tiếp → khóa bàn phím ${result.retry_in}s, đã đổi mã OTP`);
    } else {
      const [level, event, msg] = VERIFY_LOG[result.reason];
      log.add(level, event, msg(result));
    }
    changed();
  }

  function handleStatus(data) {
    const wasOnline = locker.online;
    locker.online = data.online === true;
    if (typeof data.lock === 'string') locker.lock = data.lock;
    if (typeof data.door === 'string') locker.door = data.door;
    if (typeof data.boot === 'string' && data.boot !== boot) {
      boot = data.boot; // tủ vừa khởi động lại: seq đếm lại từ 1
      lastSeq = null;
    }
    tracker.handleStatus(locker.online);
    if (wasOnline !== locker.online) {
      log.add(locker.online ? 'INFO' : 'WARN', locker.online ? 'LOCKER_ONLINE' : 'LOCKER_OFFLINE',
        locker.online ? 'Tủ đã kết nối broker' : 'Tủ mất kết nối broker');
    }
    changed();
  }

  // Sự kiện có thể đến trễ: tủ lưu vào bộ đệm vòng khi mất kết nối rồi gửi lại.
  // seq tăng dần trong một lần khởi động (boot) -> bỏ bản trùng; age (ms) -> thời điểm thật của sự kiện.
  function handleEvent(data) {
    if (typeof data.event !== 'string') return;
    const source = typeof data.source === 'string' ? data.source : '';

    if (Number.isInteger(data.seq)) {
      if (lastSeq !== null && data.seq <= lastSeq) {
        log.add('INFO', 'DUPLICATE_EVENT', `Bỏ qua sự kiện ${data.event} trùng (seq ${data.seq})`);
        return;
      }
      lastSeq = data.seq;
    }
    const age = Number.isFinite(data.age) && data.age > 0 ? Math.min(data.age, MAX_EVENT_AGE_MS) : 0;
    tracker.handleEvent(data.event, source, age ? now() - age : undefined);
    if (age >= 1000) {
      log.add('INFO', 'OFFLINE_SYNC', `Đồng bộ sự kiện ${data.event} xảy ra lúc mất kết nối (trễ ${Math.round(age / 1000)}s)`);
    }

    if (data.event === 'TAMPER') {
      log.add('CRITICAL', 'TAMPER', 'Cửa bị mở khi đang khóa – nghi cạy cửa!');
    } else {
      log.add('INFO', data.event, source ? `Nguồn: ${source}` : '');
    }
  }

  client.on('connect', () => {
    client.subscribe([topic.verify, topic.status, topic.events]);
    log.add('INFO', 'BROKER_CONNECTED', 'Server đã kết nối Mosquitto');
    changed();
  });

  client.on('close', () => {
    if (locker.online) locker.online = false;
    changed();
  });

  client.on('message', (t, payload, packet) => {
    const data = parse(payload);
    if (!data) {
      log.add('WARN', 'INVALID_PAYLOAD', `Payload không phải JSON trên ${t}`);
      return;
    }
    if (t === topic.verify) {
      if (packet && packet.retain) return;
      handleVerify(data);
    } else if (t === topic.status) {
      handleStatus(data);
    } else if (t === topic.events) {
      handleEvent(data);
    }
  });

  return {
    getLocker: () => ({ ...locker }),
    isBrokerConnected: () => client.connected === true,
    sendUnlock() {
      if (!client.connected) return false;
      client.publish(topic.command, JSON.stringify({ cmd: 'UNLOCK' }), { qos: 0, retain: false });
      return true;
    },
    onChange: (fn) => listeners.push(fn)
  };
}

module.exports = { createMqttBridge };
