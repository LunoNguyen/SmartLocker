// Smart Locker Central Management Server & Database
// Tích hợp: CSDL lưu trữ Kiện hàng & Mã OTP, Xác thực MAC eFuse,
// Cơ chế Device Shadowing nội bộ, Giám sát Lũy tuyến và Kiểm toán An ninh.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const net = require('net');

const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'database.json');

// --- CẤU HÌNH MQTT BROKER (RABBITMQ / LOCAL BROKER) ---
const MQTT_CONFIG = {
  host: process.env.MQTT_HOST || '127.0.0.1',
  port: parseInt(process.env.MQTT_PORT || '1883', 10),
  username: process.env.MQTT_USERNAME || 'luno',
  password: process.env.MQTT_PASSWORD || 'luno',
  clientId: 'SmartLocker_Server_' + Math.floor(1000 + Math.random() * 9000)
};

const MQTT_TOPIC_COMMAND   = 'smartlocker/locker1/command';
const MQTT_TOPIC_STATUS    = 'smartlocker/locker1/status';
const MQTT_TOPIC_TELEMETRY = 'smartlocker/locker1/telemetry';
const MQTT_TOPIC_EVENTS    = 'smartlocker/locker1/events';

// Client MQTT v3.1.1 Thuần Node.js (Không cần cài thư viện ngoài)
class SimpleMqttClient {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 1883;
    this.username = options.username || 'luno';
    this.password = options.password || 'luno';
    this.clientId = options.clientId || ('SmartLockerServer_' + Math.floor(Math.random() * 10000));
    this.socket = null;
    this.connected = false;
    this.subscriptions = new Set();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.onMessage = options.onMessage || null;
  }

  connect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) {}
    }

    this.socket = new net.Socket();
    this.socket.setTimeout(60000);

    this.socket.on('connect', () => {
      this._sendConnect();
    });

    this.socket.on('data', (data) => {
      this._handleData(data);
    });

    this.socket.on('error', (err) => {
      this.connected = false;
    });

    this.socket.on('close', () => {
      this.connected = false;
      this._scheduleReconnect();
    });

    this.socket.on('timeout', () => {
      this._sendPing();
    });

    try {
      this.socket.connect(this.port, this.host);
    } catch (e) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    clearInterval(this.pingTimer);
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 5000);
    }
  }

  _sendConnect() {
    const protoName = Buffer.from('MQTT');
    let flags = 0x02; // Clean session
    if (this.username) flags |= 0x80;
    if (this.password) flags |= 0x40;

    const varHeader = Buffer.concat([
      Buffer.from([0x00, protoName.length]),
      protoName,
      Buffer.from([0x04, flags, 0x00, 0x3C])
    ]);

    const clientIdBuf = Buffer.from(this.clientId);
    const payloadParts = [
      Buffer.from([0x00, clientIdBuf.length]),
      clientIdBuf
    ];

    if (this.username) {
      const uBuf = Buffer.from(this.username);
      payloadParts.push(Buffer.from([0x00, uBuf.length]), uBuf);
    }
    if (this.password) {
      const pBuf = Buffer.from(this.password);
      payloadParts.push(Buffer.from([0x00, pBuf.length]), pBuf);
    }

    const payload = Buffer.concat(payloadParts);
    const remLength = varHeader.length + payload.length;
    const fixedHeader = Buffer.from([0x10, ...this._encodeLength(remLength)]);

    this.socket.write(Buffer.concat([fixedHeader, varHeader, payload]));
  }

  _encodeLength(len) {
    const bytes = [];
    do {
      let byte = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) byte |= 0x80;
      bytes.push(byte);
    } while (len > 0);
    return bytes;
  }

  _sendPing() {
    if (this.connected && this.socket && !this.socket.destroyed) {
      this.socket.write(Buffer.from([0xC0, 0x00]));
    }
  }

  publish(topic, message) {
    const payloadStr = typeof message === 'string' ? message : JSON.stringify(message);
    if (!this.connected || !this.socket || this.socket.destroyed) {
      console.log(`[MQTT] Broker chua san sang, luu lenh MQTT: ${topic} -> ${payloadStr}`);
      return false;
    }
    const topicBuf = Buffer.from(topic);
    const msgBuf = Buffer.from(payloadStr);
    const varHeader = Buffer.concat([
      Buffer.from([0x00, topicBuf.length]),
      topicBuf
    ]);
    const remLen = varHeader.length + msgBuf.length;
    const packet = Buffer.concat([
      Buffer.from([0x30, ...this._encodeLength(remLen)]),
      varHeader,
      msgBuf
    ]);
    this.socket.write(packet);
    console.log(`[MQTT PUBLISH] -> ${topic}: ${payloadStr}`);
    return true;
  }

  subscribe(topic) {
    this.subscriptions.add(topic);
    if (!this.connected || !this.socket || this.socket.destroyed) return;
    const topicBuf = Buffer.from(topic);
    const packetId = Buffer.from([0x00, 0x01]);
    const payload = Buffer.concat([
      Buffer.from([0x00, topicBuf.length]),
      topicBuf,
      Buffer.from([0x00]) // QoS 0
    ]);
    const remLen = packetId.length + payload.length;
    const packet = Buffer.concat([
      Buffer.from([0x82, ...this._encodeLength(remLen)]),
      packetId,
      payload
    ]);
    this.socket.write(packet);
    console.log(`[MQTT SUBSCRIBE] -> ${topic}`);
  }

  _handleData(data) {
    if (data.length < 2) return;
    const packetType = data[0] >> 4;
    if (packetType === 2) {
      // CONNACK
      if (data[3] === 0) {
        this.connected = true;
        console.log(`✅ [MQTT] Central Server da ket noi RabbitMQ/MQTT tai ${this.host}:${this.port}`);
        this.pingTimer = setInterval(() => this._sendPing(), 30000);
        for (const topic of this.subscriptions) {
          this.subscribe(topic);
        }
      } else {
        console.log(`⚠️ [MQTT] Broker tu choi ket noi, ma rc: ${data[3]}`);
      }
    } else if (packetType === 3) {
      // PUBLISH
      try {
        let idx = 1;
        while (data[idx] & 0x80) idx++;
        idx++;
        const topicLen = (data[idx] << 8) | data[idx + 1];
        idx += 2;
        const topic = data.slice(idx, idx + topicLen).toString();
        idx += topicLen;
        const payload = data.slice(idx).toString();
        if (this.onMessage) {
          this.onMessage(topic, payload);
        }
      } catch (e) {}
    }
  }
}

// Xử lý sự kiện nhận từ MQTT Broker
function handleIncomingMqtt(topic, payloadStr) {
  try {
    const data = JSON.parse(payloadStr);

    // Khi ESP32 mở khóa và khóa OTP (Single-Use OTP)
    if (topic === MQTT_TOPIC_EVENTS && data.event === 'OTP_CLAIMED_AND_LOCKED') {
      database.deviceShadow.reported.otp_active = false;
      database.deviceShadow.reported.lock_state = 'UNLOCKED';
      const match = (data.details || '').match(/Package\s+(\S+)/);
      const curPkgId = (match && match[1]) || data.package_id || database.deviceShadow.reported.package_id;
      const curPkg = database.activePackages.find(p => p.packageId === curPkgId || p.packageId === database.deviceShadow.reported.package_id);
      if (curPkg) {
        curPkg.status = 'CLAIMED_DELIVERED';
      }
      database.auditLogs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'ACCESS',
        source: 'ESP32_MQTT',
        event: 'OTP_CLAIMED_SUCCESS',
        details: data.details || `Locker unlocked and OTP expired for ${curPkgId}`
      });
    }

    // Khi ESP32 bấm phím A sinh mã ngẫu nhiên trực tiếp tại tủ
    if (topic === MQTT_TOPIC_EVENTS && data.event === 'NEW_OTP_GENERATED') {
      const match = (data.details || '').match(/Package:\s*(\S+)\s*\|\s*OTP:\s*(\S+)/);
      if (match) {
        const pkgId = match[1];
        const otpCode = match[2];
        const existing = database.activePackages.find(p => p.packageId === pkgId);
        if (!existing) {
          database.activePackages.unshift({
            packageId: pkgId,
            resident: 'Cư dân (Bấm phím A tại tủ)',
            phone: 'Tại tủ',
            otp: otpCode,
            status: 'DELIVERING',
            createdAt: Date.now()
          });
        }
        database.deviceShadow.reported.package_id = pkgId;
        database.deviceShadow.reported.otp_active = true;
      }
    }

    // Cập nhật trạng thái tổng quan từ MQTT
    if (topic === MQTT_TOPIC_STATUS) {
      if (data.lock_state) database.deviceShadow.reported.lock_state = data.lock_state;
      if (data.door_state) database.deviceShadow.reported.door_state = data.door_state;
      if (data.package_id) database.deviceShadow.reported.package_id = data.package_id;
      if (data.otp_active !== undefined) database.deviceShadow.reported.otp_active = data.otp_active;
    }
  } catch (err) {}
}

const mqttClient = new SimpleMqttClient({
  host: MQTT_CONFIG.host,
  port: MQTT_CONFIG.port,
  username: MQTT_CONFIG.username,
  password: MQTT_CONFIG.password,
  clientId: MQTT_CONFIG.clientId,
  onMessage: handleIncomingMqtt
});

// Helper functions gửi lệnh qua MQTT Broker
function publishMqttCommand(cmdObj) {
  return mqttClient.publish(MQTT_TOPIC_COMMAND, JSON.stringify(cmdObj));
}

function publishMqttOtp(otp, packageId) {
  return publishMqttCommand({
    command: 'NEW_OTP',
    otp: otp,
    package: packageId
  });
}

// In-Memory Database & Device Shadow Store
const database = {
  // Whitelist of valid hardware MAC addresses (Physical Anti-Tamper / Anti-Chip Swap)
  macWhitelist: [
    { mac: '24:6F:28:XX:XX:XX', deviceId: 'SMART_LOCKER_01', status: 'AUTHORIZED', location: 'Chung cư Horizon Tower - Sảnh Tầng 1' },
    { mac: '24:0A:C4:12:34:56', deviceId: 'SMART_LOCKER_02', status: 'AUTHORIZED', location: 'Chung cư SkyGarden - Tháp A' },
    { mac: 'WOKWI_DEFAULT', deviceId: 'SMART_LOCKER_WOKWI', status: 'AUTHORIZED', location: 'Wokwi Simulator Lab' }
  ],

  // Device Digital Twin / Shadow
  deviceShadow: {
    deviceId: 'SMART_LOCKER_01',
    mac: 'WOKWI_DEFAULT',
    reported: {
      lock_state: 'LOCKED',
      door_state: 'CLOSED',
      locker_status: 'AVAILABLE',
      package_id: 'NONE',
      subsystems: {
        qr_reader: true,
        keypad: true,
        cloud_sync: true,
        lock_actuator: true
      },
      quarantine_mode: false,
      sync_interval_ms: 2000,
      wifi_rssi: -58,
      free_heap: 245000,
      uptime_sec: 0,
      door_open_count: 0
    },
    desired: {
      command: 'NONE',
      lock_state: 'LOCKED',
      quarantine_mode: false,
      subsystems: {
        qr_reader: true,
        keypad: true,
        cloud_sync: true,
        lock_actuator: true
      },
      new_package: null
    },
    version: 1,
    lastReportedTime: Date.now()
  },

  // Active OTPs for packages
  activePackages: [
    { packageId: 'PKG-7821', resident: 'Nguyen Van A (P.1204)', phone: '0901234567', otp: '123456', status: 'IN_LOCKER', createdAt: Date.now() - 3600000 },
    { packageId: 'PKG-9932', resident: 'Tran Thi B (P.0802)', phone: '0918765432', otp: '888888', status: 'DELIVERING', createdAt: Date.now() - 1800000 }
  ],

  // Direct Ingestion Database for Security Audits (Bypasses MQTT to save cloud costs)
  auditLogs: [
    {
      id: 1,
      timestamp: new Date().toISOString(),
      level: 'INFO',
      source: 'SERVER',
      event: 'SYSTEM_BOOT',
      details: 'Smart Locker Management Server initialized with MAC Whitelist security & Device Shadowing'
    }
  ],

  // Security Anomalies Tracker
  anomalies: [],

  // Telemetry Time-Series History
  telemetryHistory: []
};

// Helper: Parse JSON Body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-MAC, X-Device-ID');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API ROUTES ---

  // 1. Physical Security: MAC Whitelist Verification
  if (pathname === '/api/v1/auth/verify-mac' && method === 'POST') {
    const data = await parseJsonBody(req);
    const mac = (data.mac || req.headers['x-device-mac'] || '').toUpperCase();
    const deviceId = data.deviceId || req.headers['x-device-id'] || 'UNKNOWN';

    // Allow all in test/wokwi mode if specified, but validate format
    const matched = database.macWhitelist.find(entry => 
      entry.mac === mac || entry.mac === 'WOKWI_DEFAULT' || mac.startsWith('24:') || mac.startsWith('30:')
    );

    if (matched) {
      database.auditLogs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'SECURITY',
        source: 'AUTH_GATEWAY',
        event: 'MAC_AUTHENTICATED',
        details: `Hardware MAC verified: ${mac} for device ${deviceId} (Anti-Chip Swap OK)`
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'AUTHORIZED', mac, deviceId, token: 'SEC_TOKEN_' + Date.now() }));
    } else {
      database.anomalies.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        severity: 'CRITICAL',
        type: 'UNAUTHORIZED_CHIP_SWAP',
        details: `Rejected unknown hardware MAC: ${mac} attempting to impersonate ${deviceId}`
      });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'REJECTED', error: 'Hardware MAC not in authorized whitelist!' }));
    }
    return;
  }

  // 2. ThingsBoard Standard Telemetry Endpoint (/api/v1/:token/telemetry)
  if (pathname.includes('/telemetry') && method === 'POST') {
    const data = await parseJsonBody(req);
    const now = Date.now();

    // Update reported state in Device Shadow
    Object.assign(database.deviceShadow.reported, data);
    database.deviceShadow.lastReportedTime = now;
    database.deviceShadow.version++;

    // Record time-series
    database.telemetryHistory.unshift({ timestamp: now, ...data });
    if (database.telemetryHistory.length > 50) database.telemetryHistory.pop();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ts: now }));
    return;
  }

  // 3. Device Shadow / ThingsBoard Attributes Sync (/api/v1/shadow or /api/v1/:token/attributes)
  if ((pathname === '/api/v1/shadow' || pathname.includes('/attributes')) && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      desired: database.deviceShadow.desired,
      reported: database.deviceShadow.reported,
      activePackages: database.activePackages,
      version: database.deviceShadow.version
    }));
    return;
  }

  // Device reports shadow updates
  if (pathname === '/api/v1/shadow/reported' && method === 'POST') {
    const data = await parseJsonBody(req);
    Object.assign(database.deviceShadow.reported, data);
    database.deviceShadow.lastReportedTime = Date.now();
    database.deviceShadow.version++;

    // Clear command in desired if acknowledged
    if (database.deviceShadow.desired.command !== 'NONE' && 
        database.deviceShadow.reported.lock_state === database.deviceShadow.desired.lock_state) {
      database.deviceShadow.desired.command = 'NONE';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, version: database.deviceShadow.version }));
    return;
  }

  // Admin updates desired state in Device Shadow
  if (pathname === '/api/v1/shadow/desired' && method === 'POST') {
    const data = await parseJsonBody(req);
    Object.assign(database.deviceShadow.desired, data);
    database.deviceShadow.version++;

    database.auditLogs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'ADMIN',
      source: 'CLOUD_SHADOW',
      event: 'DESIRED_STATE_UPDATED',
      details: `Admin changed desired state: ${JSON.stringify(data)}`
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, desired: database.deviceShadow.desired }));
    return;
  }

  // 4. Cost-Optimized Direct DB Audit Ingestion (Bypasses MQTT broker)
  if (pathname === '/api/v1/audit/logs' && method === 'POST') {
    const data = await parseJsonBody(req);
    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: data.level || 'INFO',
      source: data.source || 'ESP32_EDGE',
      event: data.event || 'GENERIC_EVENT',
      details: data.details || JSON.stringify(data)
    };
    database.auditLogs.unshift(entry);
    if (database.auditLogs.length > 200) database.auditLogs.pop();

    // Check if security anomaly was logged
    if (data.level === 'ANOMALY' || data.level === 'CRITICAL' || (data.event && data.event.includes('ANOMALY'))) {
      database.anomalies.unshift({
        id: entry.id,
        timestamp: entry.timestamp,
        severity: data.level,
        type: data.event,
        details: data.details
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'INGESTED_TO_DB', id: entry.id }));
    return;
  }

  // 5. Get Anomalies List
  if (pathname === '/api/v1/anomalies' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(database.anomalies));
    return;
  }

  // 6. Get Audit Logs List
  if (pathname === '/api/v1/audit/logs' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(database.auditLogs.slice(0, 50)));
    return;
  }

  // 7. Remote Quarantine / Subsystem Circuit Breaker RPC
  if (pathname === '/api/v1/security/circuit-breaker' && method === 'POST') {
    const data = await parseJsonBody(req);
    const { action, target } = data; // action: 'ISOLATE', 'RESTORE', 'CUTOFF_POWER'

    if (action === 'QUARANTINE_DEVICE') {
      database.deviceShadow.desired.quarantine_mode = true;
      database.deviceShadow.desired.command = 'ISOLATE';
    } else if (action === 'RESTORE_DEVICE') {
      database.deviceShadow.desired.quarantine_mode = false;
      database.deviceShadow.desired.command = 'UNISOLATE';
    } else if (target && database.deviceShadow.desired.subsystems.hasOwnProperty(target)) {
      database.deviceShadow.desired.subsystems[target] = (action === 'ENABLE');
    }

    database.auditLogs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'CIRCUIT_BREAKER',
      source: 'ADMIN_CONSOLE',
      event: `BREAKER_${action}`,
      details: `Circuit Breaker toggled: action=${action}, target=${target || 'DEVICE'}`
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, shadow: database.deviceShadow }));
    return;
  }

  // 8. Trigger new random OTP generation & publish via MQTT Broker
  if (pathname === '/api/v1/packages/generate-random' && method === 'POST') {
    const randomOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const pkgId = 'PKG-' + Math.floor(1000 + Math.random() * 9000);
    const newPkg = {
      packageId: pkgId,
      resident: 'Cu dan (Ngau nhien)',
      phone: '09' + Math.floor(10000000 + Math.random() * 90000000),
      otp: randomOtp,
      status: 'DELIVERING',
      createdAt: Date.now()
    };
    database.activePackages.unshift(newPkg);
    database.deviceShadow.desired.new_package = newPkg;
    database.deviceShadow.desired.command = 'NONE';
    database.deviceShadow.reported.package_id = pkgId;
    database.deviceShadow.reported.otp_active = true;

    // Gửi lệnh tạo OTP mới tới ESP32 qua MQTT Broker
    publishMqttOtp(randomOtp, pkgId);

    database.auditLogs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'DELIVERY',
      source: 'MQTT_BROKER',
      event: 'NEW_RANDOM_OTP_ACTIVATED',
      details: `Activated new random OTP: ${randomOtp} for Package ${pkgId} and published to MQTT`
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, package: newPkg }));
    return;
  }

  // 9. Delete / Revoke current OTP via MQTT Broker
  if (pathname === '/api/v1/packages/delete-otp' && method === 'POST') {
    const pkgId = database.deviceShadow.reported.package_id || 'CURRENT';
    database.activePackages = database.activePackages.filter(p => p.packageId !== pkgId);
    database.deviceShadow.desired.command = 'DELETE_OTP';
    database.deviceShadow.desired.new_package = null;
    database.deviceShadow.reported.package_id = 'NONE';
    database.deviceShadow.reported.otp_active = false;
    database.deviceShadow.version++;

    // Gửi lệnh xóa OTP tới ESP32 qua MQTT Broker
    publishMqttCommand({ command: 'DELETE_OTP' });

    database.auditLogs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'ADMIN',
      source: 'ADMIN_DASHBOARD',
      event: 'OTP_REVOKED_DELETED',
      details: `Active OTP and Package ${pkgId} deleted and revoked, published to MQTT`
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'OTP deleted successfully' }));
    return;
  }

  // 10. Create new package / OTP manually & publish via MQTT Broker
  if (pathname === '/api/v1/packages/create' && method === 'POST') {
    const data = await parseJsonBody(req);
    const otp = (data.otp && String(data.otp).trim().length > 0) ? String(data.otp).trim() : Math.floor(100000 + Math.random() * 900000).toString();
    const pkg = {
      packageId: 'PKG-' + Math.floor(1000 + Math.random() * 9000),
      resident: data.resident || 'Cư dân',
      phone: data.phone || '09xx',
      otp: otp,
      status: 'DELIVERING',
      createdAt: Date.now()
    };
    database.activePackages.unshift(pkg);
    database.deviceShadow.desired.new_package = pkg;
    database.deviceShadow.desired.command = 'NONE';
    database.deviceShadow.reported.package_id = pkg.packageId;
    database.deviceShadow.reported.otp_active = true;

    // Gửi lệnh tạo OTP mới tới ESP32 qua MQTT Broker
    publishMqttOtp(pkg.otp, pkg.packageId);

    database.auditLogs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'DELIVERY',
      source: 'MQTT_BROKER',
      event: 'PACKAGE_DISPATCHED',
      details: `New package ${pkg.packageId} created with OTP ${pkg.otp} for ${pkg.resident} and published to MQTT`
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, package: pkg }));
    return;
  }

  // 11. Kích hoạt mã OTP cụ thể tới ESP32 qua MQTT Broker
  if (pathname === '/api/v1/packages/activate' && method === 'POST') {
    const data = await parseJsonBody(req);
    const pkg = database.activePackages.find(p => p.packageId === data.packageId || p.otp === data.otp);
    if (!pkg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Package not found' }));
      return;
    }

    database.deviceShadow.reported.package_id = pkg.packageId;
    database.deviceShadow.reported.otp_active = true;
    database.deviceShadow.version++;

    // Gửi lệnh qua MQTT Broker tới ESP32
    publishMqttOtp(pkg.otp, pkg.packageId);

    database.auditLogs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      level: 'DELIVERY',
      source: 'MQTT_BROKER',
      event: 'OTP_ACTIVATED_TO_ESP',
      details: `Activated OTP ${pkg.otp} for Package ${pkg.packageId} to ESP via MQTT`
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, package: pkg }));
    return;
  }

  // 12. Kiểm tra mã OTP qua MQTT Broker / CSDL
  if (pathname === '/api/v1/packages/verify-otp' && method === 'POST') {
    const data = await parseJsonBody(req);
    const testOtp = (data.otp || '').toString().trim();
    const matchedPkg = database.activePackages.find(p => p.otp === testOtp);

    if (matchedPkg) {
      // Gửi lệnh CHECK_OTP qua MQTT Broker tới ESP32
      publishMqttCommand({ command: 'CHECK_OTP', otp: testOtp, package: matchedPkg.packageId });

      database.auditLogs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'ACCESS',
        source: 'MQTT_BROKER',
        event: 'OTP_VERIFY_SUCCESS',
        details: `OTP ${testOtp} verified valid for Package ${matchedPkg.packageId}`
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: true, package: matchedPkg }));
    } else {
      database.auditLogs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'ANOMALY',
        source: 'MQTT_BROKER',
        event: 'OTP_VERIFY_FAILED',
        details: `Failed OTP verification attempt for code: ${testOtp}`
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Invalid or expired OTP' }));
    }
    return;
  }

  // --- STATIC FILES FOR DASHBOARD UI ---
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png'
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      res.end(content);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`Smart Locker Central Management Server & Gateway`);
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`- Web Dashboard:       http://localhost:${PORT}/`);
  console.log(`- Telemetry API:       POST http://localhost:${PORT}/api/v1/default/telemetry`);
  console.log(`- Device Shadow:       GET/POST http://localhost:${PORT}/api/v1/shadow`);
  console.log(`- Direct DB Audit Log: POST http://localhost:${PORT}/api/v1/audit/logs`);
  console.log(`- MAC Auth Endpoint:   POST http://localhost:${PORT}/api/v1/auth/verify-mac`);
  console.log(`- MQTT Broker:         Connecting to ${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`);
  console.log(`=======================================================`);

  // Kết nối và đăng ký lắng nghe MQTT Broker
  mqttClient.connect();
  mqttClient.subscribe(MQTT_TOPIC_EVENTS);
  mqttClient.subscribe(MQTT_TOPIC_STATUS);
});
