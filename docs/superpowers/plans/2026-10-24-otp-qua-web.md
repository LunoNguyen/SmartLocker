# OTP qua Web (MQTT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web Node.js sinh/giữ/kiểm tra OTP; ESP32 chỉ nhập mã và hỏi web qua Mosquitto, không bao giờ biết mã.

**Architecture:** `server/src/otp.js` là logic thuần (có `now()` tiêm vào để test). `mqttBridge.js` nối MQTT ↔ otp. `index.js` (express) phục vụ API + SSE + trang tĩnh. Firmware tách module; `main.cpp` là máy trạng thái không chặn, `net.cpp` lo MQTT.

**Tech Stack:** Node 24, express 4, mqtt 5, dotenv 16, `node:test`; ESP32 Arduino (PlatformIO), PubSubClient 2.8, ArduinoJson 6, Adafruit SSD1306.

**Spec:** `docs/superpowers/specs/2026-10-24-otp-qua-web-design.md`

## Global Constraints

- Broker `192.168.209.128:1883`, user `gateway_admin`, pass `123456`.
- Tiền tố topic `smartlocker/locker1/`; topic: `verify`, `verify/result`, `command`, `status` (retained), `events`.
- OTP 6 chữ số, sinh bằng `crypto.randomInt(0, 1_000_000)` đệm 0; TTL `OTP_TTL_MIN` mặc định 10.
- Sai 3 → khóa 30 s; sai 5 → khóa 300 s + đổi mã + `failCount = 0`.
- ESP32 timeout chờ result 5 000 ms; relay mở 6 000 ms nếu cửa không mở.
- Không mã OTP hiệu lực nào xuất hiện trong MQTT, Serial hay OLED.
- Không HTTP trên ESP32; không Master PIN; web không đăng nhập.
- Làm trên `main`, commit sau mỗi task, cuối commit có `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Mã OTP bắt đầu bằng 0 (vd `004817`) → phải nhập đúng 6 số và được chấp nhận (test trong Task 1).
2. `code` gửi dạng số JSON (`482913` không có nháy) hoặc 5/7 chữ số → bỏ qua, không tính lần sai (Task 1).
3. Mã hết hạn đúng lúc người dùng nhập → coi như mã cũ, trả `WRONG` (Task 1).
4. Broker khởi động sau server/ESP32 → cả hai tự nối lại, web bỏ thanh đỏ, ESP32 bỏ biểu tượng offline (kiểm tra thủ công Task 3 + Task 7).
5. Cửa đang mở lúc bật ESP32 → không báo `TAMPER` (Task 6).

---

## File Structure

```
server/
  package.json, .env.example, .gitignore
  src/otp.js          createOtpService({ttlMs, now, random}) — logic thuần
  src/events.js       createEventLog({limit}) — nhật ký + subscribe
  src/mqttBridge.js   createMqttBridge({client, otp, log, topics}) — MQTT ↔ otp
  src/index.js        khởi động express + mqtt
  test/otp.test.js, test/mqttBridge.test.js
  public/index.html, app.js, style.css
tools/fake-locker.js
include/config.h
src/main.cpp, keypad.{h,cpp}, ui.{h,cpp}, hardware.{h,cpp}, net.{h,cpp}
diagram.json, README.md, mosquitto/README.md
```

Xóa: `server/server.js`.

---

### Task 1: Logic OTP (`otp.js`) + khung server

**Files:**
- Create: `server/package.json`, `server/.gitignore`, `server/src/otp.js`, `server/test/otp.test.js`

**Interfaces:**
- Produces:
  ```js
  createOtpService({ ttlMs = 600000, now = Date.now, random = crypto.randomInt }) → {
    getState(): { code: string|null, createdAt: number|null, expiresAt: number|null,
                  lastUsed: {code: string, at: number}|null, failCount: number, lockedUntil: number },
    tick(): boolean,              // hết hạn → sinh mã mới, trả true nếu đã đổi
    rotate(): void,
    revoke(): void,
    clearLockout(): void,
    verify(req: string, code: unknown): null | Result
  }
  Result = {ok:true, rotated:true}
         | {ok:false, reason:'WRONG', attempts_left:number}
         | {ok:false, reason:'LOCKED_OUT', retry_in:number, critical?:true}
         | {ok:false, reason:'NO_OTP'}
         | {ok:false, reason:'INVALID'}   // bridge không trả lời ESP32 với INVALID, chỉ log
  ```
  `verify` trả `null` khi `req` trùng trong 50 req gần nhất.

- [ ] **Step 1: Tạo `server/package.json`**

`"type": "commonjs"`, scripts `"start": "node src/index.js"`, `"test": "node --test test/"`, dependencies `express@^4.21.2`, `mqtt@^5.10.1`, `dotenv@^16.4.7`. `server/.gitignore`: `node_modules/`, `.env`. Chạy `cd server && npm install`.

- [ ] **Step 2: Viết test thất bại `server/test/otp.test.js`**

Dùng đồng hồ giả `let t = 1_000_000; const now = () => t;` và `random` giả trả lần lượt từ mảng. Các test:

```js
test('sinh ma 6 so co dem 0', () => { const s = svc({codes:[4817]}); assert.equal(s.getState().code, '004817'); });
test('dung ma -> ok, ma cu het dung, ma moi sinh ngay', () => {
  const s = svc({codes:[111111, 222222]});
  assert.deepEqual(s.verify('r1','111111'), {ok:true, rotated:true});
  assert.equal(s.getState().code, '222222');
  assert.deepEqual(s.getState().lastUsed, {code:'111111', at:t});
  assert.equal(s.verify('r2','111111').reason, 'WRONG');
});
test('sai 1,2 -> attempts_left 2,1; sai 3 -> khoa 30s', ...);   // retry_in === 30
test('dang khoa -> LOCKED_OUT, khong so ma, retry_in lam tron len', ...); // t += 10_500 → retry_in 20
test('het khoa, sai lan 4 -> attempts_left 1; lan 5 -> khoa 300s, doi ma, critical, failCount 0', ...);
test('dung ma reset failCount', ...);
test('het han -> tick doi ma; nhap ma cu -> WRONG', ...);   // t += 600_000
test('req trung -> null', ...);
test('code sai dinh dang -> INVALID, khong tang failCount', ...); // 482913 (number), '48291', '4829130', 'abcdef', undefined
test('revoke -> NO_OTP, tick khong sinh lai; rotate -> co ma', ...);
test('clearLockout -> verify duoc ngay', ...);
```

- [ ] **Step 3: Chạy `cd server && npm test` → FAIL (`Cannot find module '../src/otp'`)**

- [ ] **Step 4: Cài đặt `server/src/otp.js` theo Interfaces và spec §3.2**

So sánh bằng `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` (cùng độ dài 6). `recentReqs` là mảng tối đa 50. `attempts_left` = `(failCount < 3 ? 3 : 5) - failCount`. `retry_in = Math.ceil((lockedUntil - now())/1000)`. `verify` gọi `tick()` trước khi so để mã hết hạn bị thay.

- [ ] **Step 5: Chạy `npm test` → tất cả PASS**

- [ ] **Step 6: Commit** — `feat(server): logic OTP thuan + test`

---

### Task 2: Nhật ký sự kiện + cầu nối MQTT

**Files:**
- Create: `server/src/events.js`, `server/src/mqttBridge.js`, `server/test/mqttBridge.test.js`

**Interfaces:**
- Consumes: `createOtpService` (Task 1).
- Produces:
  ```js
  createEventLog({ limit = 100 }) → {
    add(level: 'INFO'|'SUCCESS'|'WARN'|'CRITICAL', event: string, details: string): void,
    list(): Array<{ts:number, level, event, details}>,   // mới nhất trước
    onChange(fn: () => void): void
  }
  createMqttBridge({ client, otp, log, prefix = 'smartlocker/locker1/' }) → {
    getLocker(): { online: boolean, lock: string, door: string },
    isBrokerConnected(): boolean,
    sendUnlock(): boolean,
    onChange(fn: () => void): void
  }
  ```
  `client` là đối tượng kiểu `mqtt.MqttClient` (`on('connect'|'close'|'message')`, `subscribe`, `publish`, `connected`).

- [ ] **Step 1: Viết test thất bại `server/test/mqttBridge.test.js`**

Client giả là `EventEmitter` có `publish(topic, payload, opts)` ghi vào mảng `sent`, `subscribe()` rỗng, `connected = true`. OTP giả với `verify` trả giá trị định sẵn.

```js
test('connect -> subscribe verify, status, events', ...);
test('verify hop le -> publish verify/result {req, ok:true}', ...);
test('verify WRONG -> publish result co attempts_left', ...);
test('verify tra null (req trung) -> khong publish', ...);
test('verify INVALID -> khong publish, log WARN', ...);
test('verify JSON hong -> khong publish, khong throw', ...);
test('tin verify retained (packet.retain) -> bo qua', ...);
test('LOCKED_OUT critical -> log CRITICAL', ...);
test('status {online:false} -> getLocker().online false, onChange goi', ...);
test('events TAMPER -> log CRITICAL', ...);
test('sendUnlock -> publish command {"cmd":"UNLOCK"}', ...);
test('payload result khong bao gio chua ma hien tai', ...);   // JSON.stringify(sent) không chứa otp.getState().code
```

- [ ] **Step 2: Chạy `npm test` → FAIL**

- [ ] **Step 3: Cài đặt `events.js` và `mqttBridge.js`**

Result publish = `{req, ...result}` bỏ trường `rotated`, `critical`. Log: `ok` → SUCCESS `OTP_VERIFIED`; WRONG/NO_OTP → WARN; LOCKED_OUT → WARN hoặc CRITICAL nếu `critical`. Map events: `TAMPER` CRITICAL, các event khác INFO. `status` online đổi trạng thái → log INFO `LOCKER_ONLINE`/`LOCKER_OFFLINE`. `close`/`connect` của client → log broker và `onChange`.

- [ ] **Step 4: Chạy `npm test` → PASS**

- [ ] **Step 5: Commit** — `feat(server): cau noi MQTT va nhat ky su kien`

---

### Task 3: Express API + SSE, xóa server cũ

**Files:**
- Create: `server/src/index.js`, `server/.env.example`
- Delete: `server/server.js`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces (cho Task 4): `GET /api/state` trả
  ```json
  {"otp":{"code","createdAt","expiresAt","lastUsed","failCount","lockedUntil"},
   "locker":{"online","lock","door"},"broker":{"connected":bool},"log":[...],"serverTime":number}
  ```
  `GET /api/stream`: `text/event-stream`, mỗi lần đổi gửi `data: <state JSON>\n\n`. POST `/api/otp/rotate`, `/api/otp/revoke`, `/api/unlock`, `/api/lockout/clear` → trả state; `/api/unlock` trả 503 nếu broker mất.

- [ ] **Step 1: `.env.example`**

```
PORT=5000
MQTT_URL=mqtt://192.168.209.128:1883
MQTT_USERNAME=gateway_admin
MQTT_PASSWORD=123456
OTP_TTL_MIN=10
```

- [ ] **Step 2: Cài đặt `index.js`**

`require('dotenv').config()`; `mqtt.connect(MQTT_URL, {username, password, clientId: 'smartlocker-web-' + random hex, reconnectPeriod: 3000})`; `setInterval(() => { if (otp.tick()) { log.add('INFO','OTP_ROTATED',...); broadcast(); } }, 1000)`. Các thao tác rotate/revoke/clear/unlock ghi log rồi `broadcast()`. Log mã OTP **không** ghi giá trị mã (chỉ "Đã tạo mã mới"); ngoại lệ: `lastUsed` có trong state. Phục vụ `public/` bằng `express.static`. Xóa `server/server.js`.

- [ ] **Step 3: Kiểm tra thủ công**

Run: `cd server && cp .env.example .env && npm start`, rồi `curl -s localhost:5000/api/state`.
Expected: JSON có `otp.code` 6 số; console in "MQTT connected" khi VM bật, hoặc thử lại mỗi 3 s khi VM tắt mà server không crash.

- [ ] **Step 4: `npm test` vẫn PASS; commit** — `feat(server): API express + SSE, bo server.js cu`

---

### Task 4: Giao diện dashboard

**Files:**
- Modify (viết lại): `server/public/index.html`, `server/public/app.js`, `server/public/style.css`

**Interfaces:**
- Consumes: API Task 3.

- [ ] **Step 1: Viết lại 3 file theo spec §3.4**

4 khối: Mã OTP (số lớn, thanh đếm ngược từ `expiresAt` hiệu chỉnh theo `serverTime`, nút Tạo mới / Hủy / Copy, dòng "Mã X đã dùng lúc HH:MM"), Trạng thái tủ (Online/Offline, Khóa/Mở, Cửa), Bảo mật (failCount, đếm ngược `lockedUntil`, nút Gỡ khóa, Mở khóa từ xa — disable khi tủ offline), Nhật ký (màu theo level). Thanh đỏ trên cùng khi `broker.connected === false`. `EventSource('/api/stream')`, `onerror` → đợi rồi `fetch('/api/state')`. Không có code OTP → hiện "Chưa có mã" và nút Tạo mới nổi bật. Giao diện tiếng Việt, dùng được trên màn hình máy chiếu (chữ OTP ≥ 64px), không thư viện ngoài.

- [ ] **Step 2: Kiểm tra trên trình duyệt**

Mở `http://localhost:5000`: mã hiện, đếm ngược chạy; bấm Tạo mới → mã đổi không cần reload; Hủy → "Chưa có mã"; console không lỗi.

- [ ] **Step 3: Commit** — `feat(web): dashboard OTP realtime`

---

### Task 5: Giả lập ESP32 (`tools/fake-locker.js`)

**Files:**
- Create: `tools/fake-locker.js`

**Interfaces:**
- Consumes: giao thức MQTT spec §2.1; dùng `require` từ `server/node_modules` (`require(path.join(__dirname,'../server/node_modules/mqtt'))`) và đọc `server/.env`.

- [ ] **Step 1: Cài đặt**

`node tools/fake-locker.js <code>`: nối broker, đặt Last Will như ESP32, publish `status` online retained, publish `verify` `{req, code}` (req 8 hex), chờ `verify/result` khớp `req` tối đa 5 s, in kết quả, thoát mã 0 nếu `ok`, 1 nếu sai, 2 nếu timeout. `node tools/fake-locker.js --listen` chỉ in mọi `command` nhận được.

- [ ] **Step 2: Kiểm tra tích hợp (cần VM + server chạy)**

Nhập mã trên dashboard → `ok:true`; chạy lại cùng mã → `WRONG attempts_left`; sai liên tiếp tới 3 → `LOCKED_OUT retry_in:30`; tắt server → exit 2 sau 5 s. Dashboard hiện đúng log từng lần.

- [ ] **Step 3: Commit** — `feat(tools): gia lap ESP32 de test qua Mosquitto`

---

### Task 6: Firmware – config, phần cứng, keypad

**Files:**
- Modify (viết lại): `include/config.h`
- Create: `src/hardware.h`, `src/hardware.cpp`, `src/keypad.h`, `src/keypad.cpp`

**Interfaces:**
- Produces:
  ```cpp
  // config.h: WIFI_SSID "Wokwi-GUEST", WIFI_PASS "", MQTT_BROKER_HOST "192.168.209.128", MQTT_BROKER_PORT 1883,
  //   MQTT_USERNAME, MQTT_PASSWORD, MQTT_CLIENT_ID "SmartLocker_01", TOPIC_PREFIX "smartlocker/locker1/",
  //   VERIFY_TIMEOUT_MS 5000, UNLOCK_DURATION_MS 6000, MESSAGE_SHOW_MS 3000, MQTT_RETRY_MS 5000
  // hardware.h
  void hwBegin();                 // pins: RELAY 23, DOOR 18 (INPUT_PULLUP, HIGH = mở), BUZZER 15, LED 2
  void hwSetRelay(bool open);
  bool hwDoorOpen();
  enum Sound { SND_KEY, SND_OK, SND_ERROR, SND_ALARM };
  void hwPlay(Sound s);           // không chặn
  void hwUpdate();                // gọi mỗi loop: chạy chuỗi âm, nhịp LED
  // keypad.h — rows {13,12,14,27}, cols {26,25,33,32}, map như hiện tại
  void keypadBegin();
  char keypadGetKey();            // 0 nếu không có phím mới; debounce 30 ms theo millis, không chờ nhả phím
  ```

- [ ] **Step 1: Viết lại `config.h`, tạo `hardware.*`, `keypad.*`**

`hwPlay` lưu chuỗi nốt `{freq, ms}` và `hwUpdate` phát nốt kế tiếp bằng `tone()` khi tới hạn; SND_ALARM kéo dài 3 s. `keypadGetKey` mỗi lần gọi quét 1 lượt; phím chỉ được trả về một lần cho tới khi nhả.

- [ ] **Step 2: Build tạm**

Tạm thời `main.cpp` cũ còn dùng các macro cũ nên sẽ lỗi — Task 6 và 7 commit chung sau khi build sạch. Chỉ kiểm tra cú pháp bằng build ở cuối Task 7.

---

### Task 7: Firmware – mạng, OLED, máy trạng thái

**Files:**
- Create: `src/net.h`, `src/net.cpp`, `src/ui.h`, `src/ui.cpp`
- Modify (viết lại): `src/main.cpp`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  ```cpp
  // net.h
  struct VerifyResult { char req[9]; bool ok; char reason[12]; int attemptsLeft; int retryIn; };
  void netBegin(void (*onResult)(const VerifyResult&), void (*onUnlockCmd)());
  void netLoop();                       // WiFi/MQTT không chặn, thử lại mỗi MQTT_RETRY_MS
  bool netConnected();
  bool netSendVerify(const char* req, const char* code);
  void netPublishStatus(bool unlocked, bool doorOpen);   // retained
  void netPublishEvent(const char* event, const char* source);
  // ui.h
  enum Screen { SCR_IDLE, SCR_INPUT, SCR_WAITING, SCR_UNLOCKED, SCR_DENIED, SCR_NO_OTP, SCR_LOCKOUT, SCR_OFFLINE, SCR_TAMPER };
  void uiBegin();
  void uiDraw(Screen s, int digits, int number, bool online);  // number: giây còn lại hoặc attempts_left tùy màn
  ```

- [ ] **Step 1: `net.cpp`**

`WiFi.begin` một lần, không chờ. Khi WiFi lên và MQTT rớt, mỗi `MQTT_RETRY_MS`: `espClient.setTimeout(1)`/`mqtt.setSocketTimeout(2)`, `connect(id, user, pass, statusTopic, 0, true, "{\"online\":false}")`, rồi subscribe `verify/result`, `command` và publish status online. Callback parse bằng ArduinoJson; không in payload chứa mã ra Serial (in `req` và `reason` thôi).

- [ ] **Step 2: `ui.cpp`**

Mỗi màn theo bảng spec §4.4; ô nhập vẽ 6 ô, ô đã nhập tô đặc. Chỉ vẽ lại khi tham số đổi.

- [ ] **Step 3: `main.cpp` — máy trạng thái spec §4.4**

Biến: `State state; char input[7]; char pendingReq[9]; unsigned long stateSince; int number; bool lastDoor`. `setup()`: `hwBegin, keypadBegin, uiBegin, netBegin`, `lastDoor = hwDoorOpen()`. `loop()`: `netLoop(); hwUpdate();` xử lý phím, timeout, cửa (mở khi khóa → `SCR_TAMPER` 3 s + `SND_ALARM` + event `TAMPER`; đóng khi mở → khóa → `IDLE`), vẽ UI; không có `delay()` nào. `req` = `snprintf("%08lx", esp_random())`. `onResult` bỏ qua nếu `state != WAITING` hoặc `req` khác `pendingReq`. Khi mở khóa: `hwSetRelay(true)`, `netPublishEvent("UNLOCKED", source)`, `netPublishStatus`; khi khóa: tương tự `LOCKED`. Mỗi lần cửa đổi trạng thái: `netPublishEvent("DOOR_OPENED"|"DOOR_CLOSED", "SENSOR")` + `netPublishStatus`. Xóa toàn bộ code cũ (HTTP, QR, OTP, quarantine, breaker).

- [ ] **Step 4: Build**

Run: `pio run`
Expected: `[SUCCESS]`. Kiểm tra `grep -n "HTTPClient\|activeOtp\|adminMasterPin\|delay(" src/*.cpp` không có kết quả.

- [ ] **Step 5: Chạy thử trên Wokwi (VM + server bật)**

Theo checklist spec §1 mục 1–5; thêm: bật Wokwi khi công tắc cửa đang ở "mở" → không có TAMPER (Review Focus 5); bấm phím liên tục trong lúc VM tắt → phím vẫn phản hồi.

- [ ] **Step 6: Commit (gộp Task 6 + 7)** — `feat(esp32): xac thuc OTP qua MQTT, tach module, sua ket ban phim`

---

### Task 8: Sơ đồ mạch và tài liệu

**Files:**
- Modify: `diagram.json` (xóa part `qrreader1` và 4 dây `qrreader1:*`), `README.md`, `mosquitto/README.md`

- [ ] **Step 1: Sửa `diagram.json`; kiểm tra JSON hợp lệ bằng `node -e "JSON.parse(require('fs').readFileSync('diagram.json'))"`**

- [ ] **Step 2: Viết lại `README.md`**: sơ đồ kiến trúc, bảng topic, cách chạy (VM → `server` `npm install && npm start` → build + Wokwi), phím keypad, checklist demo (spec §1), lệnh `fake-locker`.

- [ ] **Step 3: `mosquitto/README.md`**: cập nhật bảng topic và lệnh `mosquitto_sub`/`pub` theo giao thức mới (bỏ `NEW_OTP`, `ISOLATE`…), IP `192.168.209.128`.

- [ ] **Step 4: Commit** — `docs: cap nhat so do mach va huong dan chay`
