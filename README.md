# Smart Locker – Nhóm 6

Tủ khóa thông minh ESP32 mở bằng mã OTP. **Web là nơi duy nhất giữ và kiểm tra mã**;
ESP32 chỉ nhận phím người dùng nhập, gửi lên MQTT và chờ kết quả. Mã không bao giờ nằm trên ESP32.

```
 ┌─ Wokwi (Windows) ─┐            ┌─ VMware Ubuntu ─┐           ┌─ Windows ──────────────┐
 │ ESP32             │  MQTT 1883 │ Mosquitto       │ MQTT 1883 │ Node.js (express+mqtt) │
 │ keypad, OLED,     │◀──────────▶│ 192.168.209.128 │◀─────────▶│  - quản lý OTP (RAM)   │
 │ relay, cửa, còi   │            │ gateway_admin   │           │  - web :5000 (SSE)     │
 └───────────────────┘            └─────────────────┘           └────────────────────────┘
```

## Cơ chế OTP

- Mã 6 số ngẫu nhiên (`crypto.randomInt`), **tự đổi sau 10 phút**.
- Nhập đúng → mở tủ, **mã bị hủy ngay** và web tạo mã mới.
- Sai 3 lần → khóa bàn phím 30 giây. Sai 5 lần → khóa 5 phút và đổi mã.
- Web tắt / mất broker → tủ chờ tối đa 5 giây rồi báo "Mat ket noi may chu", **không mở**.
- Admin trên web: Tạo mã mới · Hủy mã · Mở khóa từ xa · Gỡ khóa bàn phím.

## Nhật ký mở khóa & bất thường (MongoDB)

Server ghép các sự kiện của tủ thành **phiên mở khóa** và lưu vào MongoDB (`smartlockerlogs`).
Mã OTP không bao giờ được lưu.

| Trường (`access_logs`) | Ý nghĩa |
|---|---|
| `unlockedAt` | Thời điểm mở khóa (ngày tháng năm, giờ phút giây) |
| `method` | `OTP` (nhập keypad) / `REMOTE` (admin mở từ web) |
| `failedAttemptsBefore` | Số lần nhập sai ngay trước lần mở này |
| `doorOpenedAt`, `doorClosedAt` | Lúc cửa mở / đóng |
| `openDurationSec` | **Thời lượng mở cửa (giây)**; trống = mở khóa nhưng không mở cửa |
| `lockedAt`, `lockReason` | Lúc khóa lại; `DOOR_CLOSED` (đóng cửa) / `TIMEOUT` (6 s không mở cửa) |
| `anomalies` | Bất thường xảy ra trong lần mở này |

| Bất thường (`anomalies`) | Khi nào | Ngưỡng trong `server/.env` |
|---|---|---|
| Cạy cửa | Cửa mở khi đang khóa | – |
| Dò mã | Sai 3 lần (khóa 30 s) / 5 lần (khóa 5 phút) | – |
| Cửa mở quá lâu | Cửa mở ≥ 60 s | `DOOR_AJAR_SEC` |
| Mở ngoài giờ | Mở khóa 23:00–05:00 | `AFTER_HOURS_START`, `AFTER_HOURS_END` |
| Mở quá nhiều lần | > 5 lần / 10 phút | `FREQUENT_UNLOCK_COUNT`, `FREQUENT_UNLOCK_WINDOW_MIN` |
| Tủ mất kết nối | Offline ≥ 2 phút | `OFFLINE_ALERT_MIN` |

Trên web: tab **Nhật ký mở khóa** (lọc theo ngày / cách mở, phân trang, **Xuất CSV** mở bằng Excel)
và tab **Bất thường** (số đỏ = chưa xử lý, nút "Đã xử lý"). MongoDB tắt thì tủ vẫn mở bằng OTP bình thường,
web hiện thanh vàng báo nhật ký tạm không được lưu.

## Giao thức MQTT (`smartlocker/locker1/...`)

| Topic | Chiều | Payload |
|---|---|---|
| `verify` | ESP32 → web | `{"req":"a1b2c3d4","code":"482913"}` |
| `verify/result` | web → ESP32 | `{"req":"a1b2c3d4","ok":true}` · `{"ok":false,"reason":"WRONG","attempts_left":2}` · `"LOCKED_OUT","retry_in":30` · `"NO_OTP"` |
| `command` | web → ESP32 | `{"cmd":"UNLOCK"}` |
| `status` | ESP32 → web (retained, Last Will) | `{"online":true,"lock":"LOCKED","door":"CLOSED"}` |
| `events` | ESP32 → web | `{"event":"DOOR_OPENED"\|"DOOR_CLOSED"\|"TAMPER"\|"UNLOCKED"\|"LOCKED","source":"..."}` |

`req` là mã ngẫu nhiên mỗi lần gửi; ESP32 chỉ chấp nhận kết quả có đúng `req` mình vừa gửi.

## Chạy

1. **Bật VM Ubuntu**, kiểm tra Mosquitto (xem [mosquitto/README.md](mosquitto/README.md)).
   Từ Windows: `Test-NetConnection 192.168.209.128 -Port 1883` phải ra `True`.
2. **MongoDB** (Windows): cài [MongoDB Community Server](https://www.mongodb.com/try/download/community)
   (chọn *Install as a Service*), kèm MongoDB Compass để xem dữ liệu.
3. **Web server**
   ```bash
   cd server
   cp .env.example .env     # sửa MQTT_URL nếu IP VM khác
   npm install
   npm run init-db          # tạo database smartlockerlogs (chạy 1 lần, chạy lại vẫn an toàn)
   npm start
   ```
   Mở http://localhost:5000. Muốn demo nhanh thì đặt `OTP_TTL_MIN=1` trong `.env`.
4. **ESP32**: sửa IP trong [include/config.h](include/config.h) nếu cần → PlatformIO **Build** → chạy Wokwi (`diagram.json`).

## Bàn phím

| Phím | Tác dụng |
|---|---|
| `0`–`9` | Nhập số (tối đa 6, OLED chỉ hiện ô đã tô, không hiện số) |
| `#` | Gửi mã (khi đủ 6 số) |
| `*` | Xóa 1 số |
| `D` | Xóa hết |

Công tắc trượt = cảm biến cửa. Mở cửa khi đang khóa → còi + cảnh báo cạy cửa trên web.

## Checklist demo

1. Web hiện mã + đếm ngược; OLED hiện `ONLINE`; web hiện tủ **Online**.
2. Nhập đúng mã + `#` → relay mở, OLED "MOI MO CUA", web: mã cũ gạch ngang "đã dùng", mã mới xuất hiện.
3. Nhập lại mã cũ → "SAI MA! Con 2 lan thu".
4. Sai thêm 2 lần → "TAM KHOA 0:30", web hiện "Bị khóa".
5. Gạt công tắc cửa khi đang khóa → còi, web log đỏ `TAMPER`.
6. Bấm "Mở khóa từ xa" trên web → relay mở.
7. Tắt web server, nhập mã → sau 5 giây "Mat ket noi may chu".
8. Tab **Nhật ký mở khóa**: thấy các lần mở ở bước 2 và 6 với thời lượng mở cửa. Để cửa mở > 60 s
   (hoặc đặt `DOOR_AJAR_SEC=10` khi demo) → tab **Bất thường** có "Cửa mở quá lâu".

## Test

```bash
cd server && npm test                     # unit test OTP, cầu nối MQTT, nhật ký, API
node tools/fake-locker.js 123456          # giả lập ESP32 gửi mã qua broker thật
node tools/fake-locker.js --listen        # giả lập tủ online, in lệnh nhận được
```

## Cấu trúc

```
server/src/otp.js         logic OTP (sinh, xoay vòng, xác thực, chống dò)
server/src/mqttBridge.js  MQTT ↔ OTP
server/src/events.js      nhật ký sự kiện (RAM, hiện trên dashboard)
server/src/accessTracker.js  ghép phiên mở khóa + phát hiện bất thường
server/src/store.js       lưu MongoDB (và bản RAM cho test)
server/src/app.js         express API
server/scripts/init-db.js tạo database + schema + index
server/src/index.js       khởi động, nối các module
server/public/            dashboard
src/main.cpp              máy trạng thái ESP32 (không dùng delay)
src/net.cpp               WiFi + MQTT
src/keypad.cpp, ui.cpp, hardware.cpp
tools/fake-locker.js      giả lập ESP32
```
