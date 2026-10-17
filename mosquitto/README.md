# Mosquitto local trên máy ảo Ubuntu – Smart Locker Nhóm 6

```
┌──────────── Windows ─────────────┐        ┌──── VM Ubuntu ────┐
│ VS Code + Wokwi (ESP32 mô phỏng) │──1883─▶│ Mosquitto         │
│ server/server.js (:5000)         │        │ user gateway_admin│
└──────────────────────────────────┘        └───────────────────┘
```

ESP32 trong Wokwi đi ra mạng qua Private Gateway của Wokwi, tức là đi qua chính máy Windows.
Vì vậy: **Windows kết nối được tới Mosquitto thì ESP32 cũng kết nối được.**

## 1. Cài trên Ubuntu

Copy thư mục `mosquitto/` này vào VM (shared folder, USB, hoặc `scp`), rồi:

```bash
cd mosquitto
sudo bash setup_mosquitto.sh
```

Script sẽ: cài `mosquitto` + `mosquitto-clients` (nếu chưa có), tạo user `gateway_admin` / `123456`,
copy `smartlocker.conf` vào `/etc/mosquitto/conf.d/`, mở port 1883 trên ufw, restart service và in IP của VM.

> Mosquitto 2.x mặc định **chỉ nghe localhost** và **cấm anonymous**. Nếu không có dòng
> `listener 1883 0.0.0.0` thì Windows sẽ không kết nối được – đây là lỗi hay gặp nhất.

## 2. Mạng của máy ảo – chọn 1 cách

| | Cách A – Bridged / Host-only (khuyên dùng) | Cách B – NAT + Port Forwarding |
|---|---|---|
| Cài đặt VM | VirtualBox: Settings → Network → *Bridged Adapter* hoặc *Host-only Adapter* (VMware: Bridged / Host-only) | VirtualBox: NAT → Advanced → Port Forwarding: Host Port `1883` → Guest Port `1883` |
| `MQTT_BROKER_HOST` | IP của VM, lấy bằng `hostname -I` (VD `192.168.56.101`) | `"host.wokwi.internal"` |

Sửa trong [include/config.h](../include/config.h), rồi build lại firmware (PlatformIO: Build) trước khi chạy Wokwi.

> Bridged phụ thuộc vào Wi-Fi nơi trình bày (Wi-Fi trường có thể chặn các máy nhìn thấy nhau).
> **Host-only** không phụ thuộc mạng ngoài nên an toàn nhất khi lên lớp.

## 3. Kiểm tra từ Windows trước khi demo

PowerShell:

```powershell
Test-NetConnection 192.168.56.101 -Port 1883
```

`TcpTestSucceeded : True` là OK. (Cách B thì thay IP bằng `localhost`.)

## 4. Demo: theo dõi và gửi lệnh

Trên Ubuntu, mở terminal 1 – xem mọi thứ ESP32 gửi lên:

```bash
mosquitto_sub -h localhost -u gateway_admin -P 123456 -t 'smartlocker/#' -v
```

Terminal 2 – gửi lệnh xuống tủ:

```bash
# Mở khóa
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command -m UNLOCK
# Sinh OTP ngẫu nhiên mới
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command -m NEW_OTP
# Đẩy OTP chỉ định từ "cloud"
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command \
  -m '{"command":"NEW_OTP","otp":"246810","package":"PKG-1234"}'
# Xóa OTP / Cô lập / Bỏ cô lập
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command -m DELETE_OTP
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command -m ISOLATE
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command -m UNISOLATE
```

Log broker (thấy ESP32 `SmartLocker_01` connect/disconnect):

```bash
sudo tail -f /var/log/mosquitto/mosquitto.log
```

| Topic | Hướng | Nội dung |
|---|---|---|
| `smartlocker/locker1/command` | Broker → ESP32 | `UNLOCK`, `NEW_OTP`, `DELETE_OTP`, `ISOLATE`, `UNISOLATE` hoặc JSON `{"command":...}` |
| `smartlocker/locker1/status` | ESP32 → Broker | Trạng thái khóa, cửa, OTP, quarantine |
| `smartlocker/locker1/telemetry` | ESP32 → Broker | Thông số định kỳ |
| `smartlocker/locker1/events` | ESP32 → Broker | Sự kiện nhận hàng, brute force, cạy cửa |

## 5. Lỗi thường gặp (Serial Monitor của Wokwi)

| Log | Nguyên nhân / cách sửa |
|---|---|
| `rc=-2` | Không mở được TCP: sai IP trong `config.h`, VM chưa bật, thiếu `listener 1883 0.0.0.0`, ufw chặn, chưa port-forward (cách B) |
| `rc=-4` | Timeout – mạng VM chập chờn, thử lại `Test-NetConnection` |
| `rc=4` | Sai user/password → chạy lại `setup_mosquitto.sh` |
| `rc=5` | Không được phép → kiểm tra `password_file` trong config, xem log broker |
| Mosquitto không khởi động | `sudo journalctl -u mosquitto -n 30` – thường do trùng `listener 1883` ở file config khác trong `conf.d/` |
