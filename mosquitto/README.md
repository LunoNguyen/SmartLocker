# Mosquitto trên VMware Ubuntu – Smart Locker Nhóm 6

```
┌──────────── Windows ─────────────┐        ┌──── VM Ubuntu ─────┐
│ VS Code + Wokwi (ESP32 mô phỏng) │──1883─▶│ Mosquitto          │
│ server (Node.js :5000)           │──1883─▶│ 192.168.209.128    │
└──────────────────────────────────┘        │ user gateway_admin │
                                            └────────────────────┘
```

ESP32 trong Wokwi đi ra mạng qua chính máy Windows, nên **Windows kết nối được tới Mosquitto
thì ESP32 cũng kết nối được.**

## 1. Cài trên Ubuntu

Copy thư mục `mosquitto/` vào VM rồi:

```bash
cd mosquitto
sudo bash setup_mosquitto.sh
```

Script cài `mosquitto` + `mosquitto-clients`, tạo user `gateway_admin` / `123456`,
copy `smartlocker.conf` vào `/etc/mosquitto/conf.d/`, mở port 1883 trên ufw, restart và in IP của VM.

> Mosquitto 2.x mặc định **chỉ nghe localhost**. Thiếu dòng `listener 1883 0.0.0.0` thì Windows
> không kết nối được – lỗi hay gặp nhất.

## 2. Mạng VMware

Card mạng mặc định của VMware là **NAT (VMnet8)**: VM có IP dạng `192.168.209.x` (xem bằng `ip a`,
card `ens33`) và máy Windows truy cập thẳng được IP này. Không cần port forwarding.

IP VM có thể đổi sau khi khởi động lại (DHCP). Nếu đổi, sửa ở 2 chỗ:
- `include/config.h` → `MQTT_BROKER_HOST`, rồi build lại firmware
- `server/.env` → `MQTT_URL`

Kiểm tra từ Windows (PowerShell):

```powershell
Test-NetConnection 192.168.209.128 -Port 1883
```

## 3. Theo dõi khi demo

Trên Ubuntu – xem mọi tin nhắn của tủ (mã người dùng nhập sẽ hiện trong `verify`, mã đang hiệu lực thì **không bao giờ** xuất hiện):

```bash
mosquitto_sub -h localhost -u gateway_admin -P 123456 -t 'smartlocker/#' -v
```

Mở khóa từ xa bằng tay (giống nút trên web):

```bash
mosquitto_pub -h localhost -u gateway_admin -P 123456 -t smartlocker/locker1/command -m '{"cmd":"UNLOCK"}'
```

Log broker (thấy `SmartLocker_01` và `smartlocker-web-...` connect/disconnect):

```bash
sudo tail -f /var/log/mosquitto/mosquitto.log
```

| Topic | Chiều | Nội dung |
|---|---|---|
| `smartlocker/locker1/verify` | ESP32 → web | `{"req","code"}` mã người dùng nhập |
| `smartlocker/locker1/verify/result` | web → ESP32 | `{"req","ok","reason",...}` |
| `smartlocker/locker1/command` | web → ESP32 | `{"cmd":"UNLOCK"}` |
| `smartlocker/locker1/status` | ESP32 → web | trạng thái khóa/cửa, retained, Last Will `{"online":false}` |
| `smartlocker/locker1/events` | ESP32 → web | `DOOR_OPENED`, `DOOR_CLOSED`, `TAMPER`, `UNLOCKED`, `LOCKED` |

## 4. Lỗi thường gặp (Serial Monitor của Wokwi)

| Log | Nguyên nhân / cách sửa |
|---|---|
| `rc=-2 khong mo duoc TCP` | Sai IP trong `config.h`, VM chưa bật, thiếu `listener 1883 0.0.0.0`, ufw chặn |
| `rc=-4 timeout` | Mạng VM chập chờn, thử lại `Test-NetConnection` |
| `rc=4 sai username/password` | Chạy lại `setup_mosquitto.sh` |
| `rc=5 khong duoc phep` | Kiểm tra `password_file` trong config, xem log broker |
| OLED "Mat ket noi may chu" khi đã `ONLINE` | Web server chưa chạy hoặc `server/.env` sai IP broker |
| Mosquitto không khởi động | `sudo journalctl -u mosquitto -n 30` – thường do trùng `listener 1883` ở file khác trong `conf.d/` |
