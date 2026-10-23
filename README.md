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
2. **Web server**
   ```bash
   cd server
   cp .env.example .env     # sửa MQTT_URL nếu IP VM khác
   npm install
   npm start
   ```
   Mở http://localhost:5000. Muốn demo nhanh thì đặt `OTP_TTL_MIN=1` trong `.env`.
3. **ESP32**: sửa IP trong [include/config.h](include/config.h) nếu cần → PlatformIO **Build** → chạy Wokwi (`diagram.json`).

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

## Test

```bash
cd server && npm test                     # unit test logic OTP + cầu nối MQTT
node tools/fake-locker.js 123456          # giả lập ESP32 gửi mã qua broker thật
node tools/fake-locker.js --listen        # giả lập tủ online, in lệnh nhận được
```

## Cấu trúc

```
server/src/otp.js         logic OTP (sinh, xoay vòng, xác thực, chống dò)
server/src/mqttBridge.js  MQTT ↔ OTP
server/src/events.js      nhật ký sự kiện
server/src/index.js       express API + SSE
server/public/            dashboard
src/main.cpp              máy trạng thái ESP32 (không dùng delay)
src/net.cpp               WiFi + MQTT
src/keypad.cpp, ui.cpp, hardware.cpp
tools/fake-locker.js      giả lập ESP32
```
