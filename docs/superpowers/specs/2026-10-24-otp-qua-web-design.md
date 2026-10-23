# Smart Locker – Quản lý & xác thực OTP qua Web (MQTT)

Ngày: 2026-10-24 · Nhóm 6 · Trạng thái: chờ duyệt

## 1. Mục tiêu

Web là nơi **duy nhất** sinh, giữ và kiểm tra mã OTP. ESP32 không bao giờ biết mã đang hiệu lực:
người dùng nhập mã trên keypad → ESP32 gửi qua MQTT → web kiểm tra → trả kết quả → ESP32 mở relay
hoặc báo lỗi.

Lý do làm lại: bản hiện tại để ESP32 tự sinh OTP và phát lộ mã qua MQTT telemetry, HTTP, Serial, OLED;
bàn phím thường không nhập được do `loop()` bị chặn bởi HTTP/MQTT reconnect và chế độ Quarantine.

### Tiêu chí thành công (kịch bản demo)

1. Web hiển thị mã 6 số + đếm ngược 10 phút.
2. Nhập đúng mã trên keypad Wokwi → relay mở, OLED "Moi mo cua", web ghi log và hiện mã cũ "đã dùng", mã mới xuất hiện ngay.
3. Nhập lại mã cũ hoặc mã sai → OLED "Sai ma! Con N lan", web ghi log.
4. Sai 3 lần → khóa 30 s; sai 5 lần → khóa 5 phút + đổi mã + cảnh báo đỏ trên web.
5. Tắt server web → ESP32 nhập mã báo "Mat ket noi may chu" sau tối đa 5 s, không mở.
6. Không topic MQTT nào chứa mã OTP đang hiệu lực.

### Ràng buộc

- Broker: Mosquitto trên VMware Ubuntu, `192.168.209.128:1883`, user `gateway_admin` / `123456`.
- Web Node.js chạy trên Windows (port 5000), ESP32 chạy trong Wokwi trên Windows.
- 1 tủ, tối đa 1 OTP hiệu lực tại một thời điểm.
- Web **không** cần đăng nhập (quyết định cho demo).
- Không có Master PIN; offline thì từ chối, admin dùng nút "Mở khóa từ xa".

### Ngoài phạm vi (bỏ khỏi code hiện tại)

HTTP Device Shadow, audit log qua HTTP, MAC whitelist, Circuit Breaker, Quarantine, đầu đọc QR,
Master PIN, ESP32 tự sinh OTP, đơn hàng/cư dân, lưu trữ xuống đĩa, đăng nhập web, TLS.

## 2. Kiến trúc

```
 ┌─ Wokwi (Windows) ─┐            ┌─ VMware Ubuntu ─┐           ┌─ Windows ──────────────┐
 │ ESP32             │  MQTT 1883 │ Mosquitto       │ MQTT 1883 │ Node.js (express+mqtt) │
 │ keypad, OLED,     │◀──────────▶│ 192.168.209.128 │◀─────────▶│  - quản lý OTP (RAM)   │
 │ relay, cửa, còi   │            │ gateway_admin   │           │  - web :5000 (SSE)     │
 └───────────────────┘            └─────────────────┘           └────────────────────────┘
```

### 2.1 Giao thức MQTT

Tiền tố topic: `smartlocker/locker1/`. QoS 0 cho tất cả trừ khi ghi khác.

| Topic | Chiều | Retained | Payload |
|---|---|---|---|
| `verify` | ESP32 → web | không | `{"req":"a1b2c3d4","code":"482913"}` |
| `verify/result` | web → ESP32 | không | xem bên dưới |
| `command` | web → ESP32 | không | `{"cmd":"UNLOCK"}` |
| `status` | ESP32 → web | **có** | `{"online":true,"lock":"LOCKED"\|"UNLOCKED","door":"CLOSED"\|"OPEN"}` |
| `events` | ESP32 → web | không | `{"event":"DOOR_OPENED"\|"DOOR_CLOSED"\|"TAMPER"\|"LOCKED"\|"UNLOCKED","source":"OTP"\|"REMOTE"\|...}` |

`verify/result`:

```json
{"req":"a1b2c3d4","ok":true}
{"req":"a1b2c3d4","ok":false,"reason":"WRONG","attempts_left":2}
{"req":"a1b2c3d4","ok":false,"reason":"LOCKED_OUT","retry_in":30}
{"req":"a1b2c3d4","ok":false,"reason":"NO_OTP"}
```

- `req`: 8 ký tự hex do ESP32 sinh bằng `esp_random()`; ESP32 chỉ chấp nhận result có `req` bằng `req` đang chờ.
- Last Will của ESP32: topic `status`, payload `{"online":false}`, retained.
- Web chỉ nhìn thấy mã người dùng *nhập* (trong `verify`), không bao giờ publish mã đang hiệu lực.

## 3. Web server

### 3.1 Cấu trúc

```
server/
  package.json        dependencies: express, mqtt, dotenv
  .env.example        MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, OTP_TTL_MIN=10, PORT=5000
  src/otp.js          logic OTP thuần (không phụ thuộc MQTT/HTTP), nhận hàm now() để test
  src/events.js       nhật ký vòng 100 dòng + phát SSE
  src/mqttBridge.js   subscribe verify/status/events, gọi otp.js, publish result/command
  src/index.js        express: API + public/, nối các module
  test/otp.test.js    node:test
  public/index.html, app.js, style.css
tools/fake-locker.js  giả lập ESP32: gửi verify, in result
```

`server/server.js` cũ bị xóa.

### 3.2 Logic OTP (`otp.js`)

Trạng thái: `{ code, createdAt, expiresAt, lastUsed: {code, at} | null, failCount, lockedUntil, recentReqs }`.

- **Sinh mã:** `crypto.randomInt(0, 1_000_000)` đệm 0 đủ 6 chữ số. Sinh khi khởi động.
- **Xoay vòng:** hết `expiresAt` (TTL = `OTP_TTL_MIN`, mặc định 10 phút) → sinh mã mới.
- **verify(req, code)** theo thứ tự:
  1. `req` đã gặp trong 50 req gần nhất → bỏ qua (không trả lời).
  2. `code` không phải chuỗi 6 chữ số → bỏ qua, ghi log `INVALID_PAYLOAD`, không tính lần sai.
  3. Đang khóa (`now < lockedUntil`) → `LOCKED_OUT` với `retry_in` = số giây còn lại (làm tròn lên).
  4. Không có mã hiệu lực → `NO_OTP`.
  5. So sánh bằng `crypto.timingSafeEqual`.
     - Đúng → `ok:true`; `lastUsed = {code, at}`; `failCount = 0`; sinh mã mới ngay (TTL mới).
     - Sai → `failCount++`:
       - `failCount` = 3 → khóa 30 s, trả `LOCKED_OUT, retry_in:30`.
       - `failCount` ≥ 5 → khóa 5 phút, hủy mã + sinh mã mới, ghi log mức `CRITICAL`, trả `LOCKED_OUT, retry_in:300`, đặt lại `failCount = 0`.
       - còn lại → `WRONG, attempts_left` = số lần sai còn lại trước mốc khóa kế tiếp (3 hoặc 5).
- **rotate()**: sinh mã mới ngay. **revoke()**: xóa mã và hủy hẹn giờ xoay vòng; tủ không có mã cho tới khi admin bấm "Tạo mã mới". **clearLockout()**: `lockedUntil = 0`, `failCount = 0`.
- Tin `verify` có cờ retained bị bỏ qua (xử lý ở `mqttBridge.js`).

### 3.3 API

| Method | Đường dẫn | Tác dụng |
|---|---|---|
| GET | `/api/state` | OTP hiện tại, hạn, lastUsed, failCount, lockedUntil, trạng thái tủ, trạng thái broker, nhật ký |
| GET | `/api/stream` | SSE, đẩy toàn bộ `state` mỗi khi có thay đổi |
| POST | `/api/otp/rotate` | Tạo mã mới |
| POST | `/api/otp/revoke` | Hủy mã |
| POST | `/api/unlock` | Publish `{"cmd":"UNLOCK"}` |
| POST | `/api/lockout/clear` | Gỡ khóa bàn phím |

SSE chỉ đẩy khi trạng thái đổi; trình duyệt tự đếm ngược từ `expiresAt` / `lockedUntil`.

### 3.4 Giao diện

Một trang, 4 khối:

1. **Mã OTP** – số lớn, thanh đếm ngược, nút Tạo mới / Hủy / Copy, dòng "Mã 482913 đã dùng lúc 14:02".
2. **Trạng thái tủ** – Online/Offline, Khóa/Mở, Cửa đóng/mở; thanh đỏ khi server mất broker.
3. **Bảo mật** – số lần sai, đếm ngược khi khóa, nút Gỡ khóa, nút Mở khóa từ xa.
4. **Nhật ký** – realtime, tô màu theo mức (INFO / SUCCESS / WARN / CRITICAL).

## 4. Firmware ESP32

### 4.1 Cấu trúc

```
include/config.h      WiFi, broker, topic, thời gian
src/main.cpp          setup/loop + máy trạng thái
src/keypad.cpp/.h     quét 4x4 không chặn (debounce theo millis)
src/ui.cpp/.h         vẽ OLED theo trạng thái
src/hardware.cpp/.h   relay, cảm biến cửa, còi, LED
src/net.cpp/.h        WiFi + MQTT, publish verify/status/events, callback result/command
```

Chân nối giữ nguyên theo `diagram.json`; xóa phần tử `qrreader1` và dây của nó.

### 4.2 Không chặn vòng lặp

- Không còn HTTP.
- MQTT: `setSocketTimeout` ngắn, kết nối bằng IP, thử lại mỗi 5 s.
- Chờ kết quả xác thực bằng mốc `millis()`, timeout 5 s.
- Keypad debounce bằng `millis()`, không vòng `while` chờ nhả phím.
- `lastDoorState` khởi tạo từ trạng thái thật lúc boot.

### 4.3 Keypad

`0-9` nhập (tối đa 6) · `#` gửi (chỉ khi đủ 6 số) · `*` xóa 1 số · `D` xóa hết. Các phím khác bỏ qua.
OLED hiển thị `● ● ● ● _ _`, không hiện số.

### 4.4 Máy trạng thái

| Trạng thái | OLED | Chuyển |
|---|---|---|
| `IDLE` | "Nhap ma OTP" + biểu tượng online/offline | phím số → `INPUT` |
| `INPUT` | ô nhập che số | `#` đủ 6 số: online → `WAITING`, offline → `OFFLINE_ERR`; `D` → `IDLE` |
| `WAITING` | "Dang xac thuc..." | `ok` → `UNLOCKED`; `WRONG`/`NO_OTP` → `DENIED`; `LOCKED_OUT` → `LOCKOUT`; quá 5 s → `OFFLINE_ERR` |
| `UNLOCKED` | "Moi mo cua" + đếm ngược | không mở cửa trong 6 s → khóa → `IDLE`; mở cửa → chờ đóng → khóa → `IDLE` |
| `DENIED` | "Sai ma! Con N lan" / "Chua co ma OTP" (3 s) | → `IDLE` |
| `LOCKOUT` | "Tam khoa m:ss" | hết `retry_in` → `IDLE` |
| `OFFLINE_ERR` | "Mat ket noi may chu" (3 s) | → `IDLE` |

`command` `UNLOCK` ở bất kỳ trạng thái nào trừ `UNLOCKED` → `UNLOCKED` (source `REMOTE`).

### 4.5 Cạy cửa

Cửa chuyển sang mở khi relay đang khóa → còi 3 s, OLED cảnh báo, publish `events` `TAMPER`.
Không khóa bàn phím.

### 4.6 Âm báo

Phím: tiếng bíp ngắn · Đúng: 2 tiếng cao · Sai: 1 tiếng trầm dài · Khóa/Cạy cửa: còi ngắt quãng.
Phát bằng `tone()` không chặn.

## 5. Xử lý lỗi

| Tình huống | Xử lý |
|---|---|
| Server mất broker | `mqtt` tự reconnect; web hiện thanh đỏ "Mất kết nối broker" |
| ESP32 rớt mạng | Last Will → web "Tủ offline" |
| Web tắt, ESP32 chạy | Timeout 5 s → "Mat ket noi may chu", không mở |
| Payload sai / code không đủ 6 số | Bỏ qua, ghi log, không tính lần sai |
| `req` trùng hoặc tin retained trên `verify` | Bỏ qua |
| Result `req` không khớp | ESP32 bỏ qua |
| Trình duyệt mất SSE | `EventSource` tự nối lại, gọi lại `/api/state` |

## 6. Kiểm thử

- **Unit (`node --test`)** cho `otp.js` với `now()` giả: định dạng 6 số; đúng mã → ok + sinh mã mới + mã cũ hết dùng được;
  sai mã → attempts_left; mốc 3 → khóa 30 s; mốc 5 → khóa 300 s + đổi mã; hết hạn → xoay vòng; req trùng bị bỏ qua;
  payload sai không tính lần sai; revoke → `NO_OTP`; clearLockout.
- **Tích hợp:** `node tools/fake-locker.js <code>` qua Mosquitto trong VM, kiểm tra từng `reason`.
- **Firmware:** `pio run` build sạch; chạy checklist demo (mục 1) trên Wokwi.

## 7. Cấu hình & chạy

- `include/config.h`: `MQTT_BROKER_HOST "192.168.209.128"`, user/pass như trên.
- `server/.env` (copy từ `.env.example`), `npm install`, `npm start`, mở `http://localhost:5000`.
- README cập nhật: bước chạy, checklist demo, sơ đồ topic.
