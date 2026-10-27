# Smart Locker – Nhóm 6

Tủ khóa giao hàng thông minh dùng ESP32, mở bằng mã OTP 6 số.

- **Web server là nơi duy nhất giữ và kiểm tra mã OTP.** ESP32 chỉ nhận phím người dùng nhập, gửi lên
  MQTT broker và chờ web trả lời đúng/sai – mã đang hiệu lực không bao giờ nằm trên mạch.
- Mã tự đổi sau **10 phút**, **dùng một lần** (mở xong là hủy), có **chống dò mã**.
- Mỗi lần mở tủ được ghi **nhật ký vào MongoDB** (thời điểm mở, thời lượng mở cửa…), kèm **phát hiện bất thường**
  (cạy cửa, dò mã, cửa mở quá lâu, mở ngoài giờ…).
- Dashboard web quản lý mã, theo dõi tủ theo thời gian thực, xem nhật ký và xuất CSV.

```
 ┌─ Windows ─────────────────────────────┐          ┌─ VMware Ubuntu ──┐
 │  VS Code + Wokwi: ESP32 (mô phỏng)    │◀── MQTT ─▶│  Mosquitto       │
 │  Web server Node.js :5000 ────────────│◀── 1883 ─▶│  192.168.209.128 │
 │      │                ▲               │          │  gateway_admin   │
 │      ▼ ghi nhật ký    │ HTTP + SSE    │          └──────────────────┘
 │  MongoDB :27017    Trình duyệt       │
 └───────────────────────────────────────┘
```

---

## Mục lục

1. [Yêu cầu](#1-yêu-cầu)
2. [Cài đặt](#2-cài-đặt)
3. [Chạy hệ thống](#3-chạy-hệ-thống)
4. [Sử dụng](#4-sử-dụng)
5. [Cấu hình](#5-cấu-hình)
6. [Kiểm thử](#6-kiểm-thử)
7. [Xử lý sự cố](#7-xử-lý-sự-cố)
8. [Cơ chế hoạt động](#8-cơ-chế-hoạt-động)
9. [Cấu trúc thư mục](#9-cấu-trúc-thư-mục)

---

## 1. Yêu cầu

**Máy Windows**

| Phần mềm | Ghi chú |
|---|---|
| [VS Code](https://code.visualstudio.com/) | |
| Extension **PlatformIO IDE** | Build firmware ESP32 |
| Extension **Wokwi Simulator** | Mô phỏng mạch; lần đầu cần lấy license miễn phí: `F1` → *Wokwi: Request a New License* |
| [Node.js](https://nodejs.org/) 18 trở lên | Đã chạy với Node 24 |
| [MongoDB Community Server](https://www.mongodb.com/try/download/community) | Chọn *Install MongoDB as a Service*; nên cài kèm **MongoDB Compass** để xem dữ liệu |
| [Git](https://git-scm.com/) | |
| VMware Workstation | Chạy máy ảo Ubuntu làm MQTT broker |

**Máy ảo Ubuntu** (VMware, card mạng **NAT** mặc định): cài Mosquitto bằng script có sẵn (mục 2.2).

---

## 2. Cài đặt

### 2.1. Lấy mã nguồn

```bash
git clone https://github.com/LunoNguyen/SmartLocker.git
cd SmartLocker
```

### 2.2. MQTT broker Mosquitto (trên Ubuntu)

1. Copy thư mục `mosquitto/` vào máy ảo (kéo thả qua VMware, shared folder, hoặc USB).
2. Trong máy ảo:
   ```bash
   cd mosquitto
   sudo bash setup_mosquitto.sh
   ```
   Script cài `mosquitto` + `mosquitto-clients`, tạo tài khoản `gateway_admin` / `123456`,
   mở cổng 1883 và in ra **IP của máy ảo** (VD `192.168.209.128`) – ghi lại IP này.
3. Kiểm tra từ Windows (PowerShell) – phải ra `TcpTestSucceeded : True`:
   ```powershell
   Test-NetConnection 192.168.209.128 -Port 1883
   ```

Chi tiết và lỗi thường gặp của broker: [mosquitto/README.md](mosquitto/README.md).

### 2.3. MongoDB (trên Windows)

Cài MongoDB Community Server dạng service (tự chạy khi bật máy, cổng `27017`).
Database được tạo ở bước 2.4 bằng lệnh `npm run init-db`.

### 2.4. Web server

```bash
cd server
cp .env.example .env
npm install
npm run init-db
```

Mở `server/.env`, sửa `MQTT_URL` cho đúng IP máy ảo:

```ini
MQTT_URL=mqtt://192.168.209.128:1883
```

`npm run init-db` tạo database `smartlockerlogs` gồm 2 collection `access_logs`, `anomalies`
(có ràng buộc kiểu dữ liệu và index). Chạy lại nhiều lần vẫn an toàn, không mất dữ liệu.

### 2.5. Firmware ESP32 + Wokwi

1. Mở thư mục `SmartLocker` bằng VS Code (cài extension PlatformIO + Wokwi khi được gợi ý).
2. Nếu IP máy ảo khác `192.168.209.128`, sửa trong [include/config.h](include/config.h):
   ```cpp
   #define MQTT_BROKER_HOST    "192.168.209.128"
   ```
3. Build firmware: thanh trạng thái PlatformIO → **✓ Build** (hoặc `pio run`).
   File `wokwi.toml` đã trỏ sẵn tới firmware vừa build.

---

## 3. Chạy hệ thống

Mỗi lần demo, bật theo thứ tự:

1. **Bật máy ảo Ubuntu** (Mosquitto tự chạy khi khởi động).
2. **Web server**:
   ```bash
   cd server
   npm start
   ```
   Console phải có `BROKER_CONNECTED` và `DB_CONNECTED`. Mở **http://localhost:5000**.
3. **Mô phỏng ESP32**: trong VS Code nhấn `F1` → **Wokwi: Start Simulator**.
   Serial Monitor phải có `[MQTT] Da ket noi broker`; màn hình OLED hiện `ONLINE`;
   dashboard hiện tủ **Online**.

> Sửa `diagram.json` thì phải dừng và chạy lại mô phỏng. Sửa code trong `src/` thì phải Build lại.

---

## 4. Sử dụng

### 4.1. Mở tủ bằng mã OTP

1. Lấy mã 6 số trên dashboard (tab **Điều khiển**).
2. Trên bàn phím của tủ nhập 6 số rồi bấm `#`.
3. Mã đúng → OLED hiện **"MOI MO CUA"**, relay nhả chốt (đèn đỏ **LOCK** sáng).
   Mã vừa dùng bị hủy ngay, dashboard hiện mã mới.
4. Mở cửa (gạt công tắc trượt sang vị trí mở), lấy hàng, đóng cửa (gạt lại) → tủ tự khóa.
   Nếu không mở cửa trong 6 giây, tủ tự khóa lại.

**Bàn phím**

| Phím | Tác dụng |
|---|---|
| `0`–`9` | Nhập số (tối đa 6; OLED chỉ tô ô đã nhập, không hiện số) |
| `#` | Gửi mã (chỉ khi đủ 6 số) |
| `*` | Xóa 1 số |
| `D` | Xóa hết |

**Màn hình OLED**

| Hiển thị | Ý nghĩa |
|---|---|
| `Nhap ma OTP` + `ONLINE` / `OFFLN` | Chờ nhập; trạng thái kết nối broker |
| `Dang xac thuc...` | Đã gửi mã, đang chờ web trả lời (tối đa 5 giây) |
| `MOI MO CUA` + đếm ngược | Mã đúng, chốt đang nhả |
| `SAI MA! Con N lan thu` | Mã sai, còn N lần trước khi bị khóa |
| `TAM KHOA m:ss` | Sai quá nhiều lần, bàn phím bị khóa |
| `Chua co ma OTP` | Admin đã hủy mã, chưa tạo mã mới |
| `Mat ket noi may chu` | Không có phản hồi từ web – **tủ không mở** |
| `CANH BAO! Cua bi mo trai phep` | Cửa bị mở khi đang khóa (cạy cửa), còi hú |

**Các linh kiện trên mạch**

| Linh kiện | Ý nghĩa |
|---|---|
| Đèn đỏ **LOCK** | Sáng = chốt đang nhả (tủ mở); tắt = đang khóa |
| Đèn **LED1** trên relay | Relay đang kích |
| Đèn xanh **STATUS** | Nháy chậm (0,8 s): đã kết nối MQTT · nháy nhanh (0,15 s): mất kết nối |
| Công tắc trượt | Cảm biến cửa (mở / đóng) |
| Còi | Bíp khi bấm phím, báo đúng/sai, hú khi cạy cửa hoặc bị khóa do dò mã |

### 4.2. Dashboard web (http://localhost:5000)

**Tab Điều khiển**

- **Mã OTP hiện tại** + thanh đếm ngược tới lúc tự đổi mã.
- **Tạo mã mới** – đổi mã ngay · **Hủy mã** – tủ không có mã cho tới khi tạo mới · **Copy**.
- **Trạng thái tủ**: Online/Offline, Khóa/Mở, Cửa đóng/mở.
- **Mở khóa từ xa** – gửi lệnh mở tủ (chỉ bật khi tủ Online).
- **Bảo mật bàn phím**: số lần sai liên tiếp, thời gian bị khóa, nút **Gỡ khóa bàn phím**.
- **Nhật ký** sự kiện theo thời gian thực.

**Tab Nhật ký mở khóa** – mỗi lần mở tủ một dòng: thời điểm mở khóa, cách mở (nhập OTP / mở từ xa),
số lần nhập sai trước đó, giờ mở/đóng cửa, **thời lượng mở cửa**, cách khóa lại và bất thường kèm theo.
Lọc theo khoảng ngày và cách mở, phân trang, nút **Xuất CSV** (mở được bằng Excel).

**Tab Bất thường** – danh sách bất thường, số đỏ trên tab là số chưa xử lý.
Bấm **Đã xử lý** sau khi kiểm tra. Có bất thường mới thì dashboard hiện thông báo.

| Bất thường | Khi nào | Mức độ |
|---|---|---|
| Cạy cửa | Cửa mở khi tủ đang khóa | Nghiêm trọng |
| Dò mã (khóa 30s) | Nhập sai 3 lần liên tiếp | Cảnh báo |
| Dò mã (khóa 5 phút) | Nhập sai 5 lần – mã cũng bị đổi | Nghiêm trọng |
| Cửa mở quá lâu | Cửa mở ≥ 60 giây | Cảnh báo |
| Mở ngoài giờ | Mở khóa từ 23:00 đến 05:00 | Cảnh báo |
| Mở quá nhiều lần | Hơn 5 lần trong 10 phút | Cảnh báo |
| Tủ mất kết nối | Offline ≥ 2 phút | Cảnh báo |

### 4.3. Xem dữ liệu trong MongoDB

Mở **MongoDB Compass** → kết nối `mongodb://127.0.0.1:27017` → database `smartlockerlogs`
→ collection `access_logs` (nhật ký mở khóa) và `anomalies` (bất thường).

### 4.4. Theo dõi thông điệp MQTT (trên Ubuntu)

```bash
# xem mọi thông điệp của tủ
mosquitto_sub -h localhost -u gateway_admin -P 123456 -t 'smartlocker/#' -v

# mở khóa bằng tay (giống nút trên web)
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command -m '{"cmd":"UNLOCK"}'
```

### 4.5. Kịch bản demo

1. Dashboard hiện mã + đếm ngược; OLED hiện `ONLINE`; dashboard hiện tủ **Online**.
2. Nhập đúng mã + `#` → OLED "MOI MO CUA", đèn LOCK sáng; dashboard: mã cũ gạch ngang "đã dùng", mã mới xuất hiện.
3. Nhập lại mã cũ → "SAI MA! Con 2 lan thu".
4. Sai thêm 2 lần → "TAM KHOA 0:30"; dashboard hiện "Bị khóa"; tab Bất thường có "Dò mã".
5. Gạt công tắc cửa khi đang khóa → còi hú, nhật ký đỏ `TAMPER`, tab Bất thường có "Cạy cửa".
6. Bấm **Mở khóa từ xa** → tủ mở.
7. Tắt web server (`Ctrl+C`), nhập mã → sau 5 giây "Mat ket noi may chu", tủ **không** mở.
8. Tab **Nhật ký mở khóa**: thấy các lần mở ở bước 2 và 6 cùng thời lượng mở cửa; bấm **Xuất CSV**.

> Demo nhanh: trong `server/.env` đặt `OTP_TTL_MIN=1` (đổi mã mỗi phút) và `DOOR_AJAR_SEC=10`
> (cửa mở 10 giây đã báo bất thường), rồi chạy lại `npm start`.

---

## 5. Cấu hình

**`server/.env`** (chạy lại `npm start` sau khi sửa)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `5000` | Cổng dashboard |
| `MQTT_URL` | `mqtt://192.168.209.128:1883` | Địa chỉ broker |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | `gateway_admin`, `123456` | Tài khoản broker |
| `OTP_TTL_MIN` | `10` | Số phút trước khi mã tự đổi |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/smartlockerlogs` | Địa chỉ MongoDB |
| `DOOR_AJAR_SEC` | `60` | Cửa mở bao nhiêu giây thì báo "cửa mở quá lâu" |
| `AFTER_HOURS_START`, `AFTER_HOURS_END` | `23`, `5` | Khung giờ tính là "ngoài giờ" |
| `FREQUENT_UNLOCK_COUNT`, `FREQUENT_UNLOCK_WINDOW_MIN` | `5`, `10` | Quá N lần mở trong M phút thì báo |
| `OFFLINE_ALERT_MIN` | `2` | Tủ offline bao nhiêu phút thì báo |

**`include/config.h`** (Build lại firmware sau khi sửa): IP/cổng/tài khoản broker, tên topic,
thời gian chờ xác thực (`VERIFY_TIMEOUT_MS = 5000`), thời gian giữ chốt mở (`UNLOCK_DURATION_MS = 6000`).

**`diagram.json`** – sơ đồ mạch Wokwi. Relay đặt `"transistor": "pnp"` để kích ở mức HIGH
(khớp firmware: HIGH = nhả chốt); nguồn relay và đèn LOCK lấy từ chân `3V3`.

---

## 6. Kiểm thử

```bash
cd server
npm test                                   # unit test: OTP, cầu nối MQTT, nhật ký, API
```

Giả lập tủ ESP32 (không cần Wokwi), chạy từ thư mục gốc khi web server đang chạy:

```bash
node tools/fake-locker.js 123456           # gửi mã, in kết quả web trả về
node tools/fake-locker.js --listen         # đóng vai tủ online, in lệnh UNLOCK nhận được
```

---

## 7. Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách sửa |
|---|---|
| Serial: `[MQTT] That bai rc=-2` | Không tới được broker: VM chưa bật, sai IP trong `config.h`, Mosquitto chưa chạy. Kiểm tra `Test-NetConnection <IP> -Port 1883` |
| Serial: `rc=4` / `rc=5` | Sai tài khoản broker → chạy lại `sudo bash setup_mosquitto.sh` |
| OLED `ONLINE` nhưng nhập mã báo "Mat ket noi may chu" | Web server chưa chạy hoặc `MQTT_URL` trong `server/.env` sai IP |
| Dashboard thanh đỏ "Mất kết nối broker" | Như trên – kiểm tra VM và `MQTT_URL` |
| Dashboard thanh vàng "Mất kết nối MongoDB" | MongoDB chưa chạy: `services.msc` → *MongoDB Server* → Start. Tủ vẫn mở được, chỉ nhật ký không được lưu |
| Nhập đúng mã nhưng báo sai | Đang có **hai** chương trình cùng trả lời xác thực (VD chạy 2 web server). Chỉ chạy một |
| Tủ liên tục Online/Offline trên dashboard | Hai mô phỏng Wokwi cùng chạy (trùng Client ID `SmartLocker_01`) – chỉ chạy một |
| Dashboard báo mở khóa nhưng đèn LOCK không sáng | Chưa chạy lại mô phỏng sau khi sửa `diagram.json`; kiểm tra relay có `"transistor": "pnp"` và dây `relay1:COM`, `relay1:VCC` nối `esp:3V3` |
| `npm run init-db` lỗi | MongoDB chưa chạy hoặc `MONGODB_URI` sai |
| Đổi IP máy ảo | Sửa `MQTT_BROKER_HOST` trong `include/config.h` (Build lại) và `MQTT_URL` trong `server/.env` |

---

## 8. Cơ chế hoạt động

### OTP

- Sinh mã 6 số bằng `crypto.randomInt` (cho phép số 0 ở đầu), lưu **chỉ trong RAM** của web server.
- Tự đổi sau `OTP_TTL_MIN` phút; mã đúng bị hủy ngay sau khi dùng và mã mới được tạo.
- Sai 3 lần liên tiếp → khóa bàn phím 30 giây; sai 5 lần → khóa 5 phút và đổi mã.
- So sánh mã bằng `crypto.timingSafeEqual`. Mã không được gửi xuống ESP32 và không ghi vào database.

### Giao thức MQTT (`smartlocker/locker1/...`)

| Topic | Chiều | Payload |
|---|---|---|
| `verify` | ESP32 → web | `{"req":"a1b2c3d4","code":"482913"}` |
| `verify/result` | web → ESP32 | `{"req":"a1b2c3d4","ok":true}` · `{"ok":false,"reason":"WRONG","attempts_left":2}` · `"LOCKED_OUT","retry_in":30` · `"NO_OTP"` |
| `command` | web → ESP32 | `{"cmd":"UNLOCK"}` |
| `status` | ESP32 → web (retained, Last Will) | `{"online":true,"lock":"LOCKED","door":"CLOSED"}` |
| `events` | ESP32 → web | `{"event":"UNLOCKED"\|"LOCKED"\|"DOOR_OPENED"\|"DOOR_CLOSED"\|"TAMPER","source":"..."}` |

`req` là mã ngẫu nhiên cho mỗi lần gửi; ESP32 chỉ chấp nhận kết quả có đúng `req` vừa gửi và
chờ tối đa 5 giây. Tất cả topic dùng QoS 0; chỉ `status` được retain.

### Nhật ký (MongoDB `smartlockerlogs`)

Web server ghép các sự kiện của tủ thành **phiên mở khóa** (firmware không phải gửi nhật ký riêng):

| Trường `access_logs` | Ý nghĩa |
|---|---|
| `unlockedAt` | Thời điểm mở khóa |
| `method` | `OTP` / `REMOTE` |
| `failedAttemptsBefore` | Số lần nhập sai ngay trước lần mở |
| `doorOpenedAt`, `doorClosedAt` | Lúc cửa mở / đóng |
| `openDurationSec` | Thời lượng mở cửa (giây); trống nếu không mở cửa |
| `lockedAt`, `lockReason` | Lúc khóa lại; `DOOR_CLOSED` / `TIMEOUT` / `UNKNOWN` |
| `status` | `IN_PROGRESS` / `DONE` |
| `anomalies` | Bất thường xảy ra trong lần mở |

Collection `anomalies`: `type`, `severity` (`WARN`/`CRITICAL`), `message`, `at`, `accessLogId`, `resolved`, `resolvedAt`.

---

## 9. Cấu trúc thư mục

```
SmartLocker/
├── diagram.json              sơ đồ mạch Wokwi
├── wokwi.toml                trỏ tới firmware đã build
├── platformio.ini            cấu hình build ESP32
├── include/config.h          WiFi, broker, topic, thời gian
├── src/
│   ├── main.cpp              máy trạng thái của tủ (không dùng delay)
│   ├── net.cpp               WiFi + MQTT
│   ├── keypad.cpp            quét bàn phím 4x4
│   ├── ui.cpp                màn hình OLED
│   └── hardware.cpp          relay, cảm biến cửa, còi, LED
├── server/
│   ├── src/
│   │   ├── index.js          khởi động, nối các module
│   │   ├── app.js            API + SSE
│   │   ├── otp.js            sinh / đổi / xác thực mã, chống dò
│   │   ├── mqttBridge.js     MQTT ↔ OTP
│   │   ├── accessTracker.js  ghép phiên mở khóa, phát hiện bất thường
│   │   ├── store.js          lưu MongoDB
│   │   └── events.js         nhật ký sự kiện trên dashboard
│   ├── public/               giao diện dashboard
│   ├── scripts/init-db.js    tạo database + schema + index
│   ├── test/                 unit test
│   └── .env.example          mẫu cấu hình
├── mosquitto/                cấu hình + script cài broker trên Ubuntu
├── tools/fake-locker.js      giả lập tủ ESP32 để kiểm thử
└── docs/                     tài liệu thiết kế
```
