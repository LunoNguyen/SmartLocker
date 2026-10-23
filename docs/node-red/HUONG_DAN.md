# Hướng dẫn dựng Node-RED cho Smart Locker (từng phần)

Node-RED thay cho web Node.js (`server/`). ESP32, Mosquitto và giao thức MQTT **giữ nguyên**.

```
ESP32 (Wokwi) ──MQTT──▶ Mosquitto (VM :1883) ◀──MQTT── Node-RED (VM :1880)
                                                         ├─ verify → kiểm tra OTP → verify/result
                                                         ├─ mỗi 1 giây: đổi mã khi hết 10 phút, cập nhật dashboard
                                                         └─ dashboard: mã, đếm ngược, trạng thái tủ, nút, nhật ký
```

> ⚠️ **Không chạy `npm start` (server Node.js) cùng lúc với Node-RED.** Cả hai sẽ cùng trả lời
> yêu cầu xác thực và mỗi bên giữ một mã OTP khác nhau.

Logic OTP **không viết lại** trong Node-RED. Ta nạp file `server/src/otp.js` (đã có 17 test) vào
Node-RED; các node function chỉ gọi `otp.verify()`, `otp.rotate()`...

Mỗi phần làm xong đều bấm **Deploy** (nút đỏ góc phải) rồi kiểm tra trước khi sang phần sau.

---

## Phần 0 – Cài Node-RED trên Ubuntu

```bash
bash <(curl -sL https://github.com/node-red/linux-installers/releases/latest/download/update-nodejs-and-nodered-deb)
```

Trả lời `y` cho các câu hỏi. Sau khi cài:

```bash
sudo systemctl enable --now nodered
sudo ufw allow 1880/tcp        # nếu ufw đang bật
```

Từ Windows mở **http://192.168.209.128:1880** → thấy giao diện kéo thả là xong.

### Cài Dashboard

Menu ☰ (góc phải) → **Manage palette** → tab **Install** → tìm `@flowfuse/node-red-dashboard` → **Install**.
Bên trái sẽ có thêm nhóm node **dashboard 2**.

## Phần 1 – Nạp `otp.js` vào Node-RED

1. Đưa file `server/src/otp.js` vào VM, đặt ở `/home/luno/smartlocker/otp.js`. Có thể dùng:
   - Shared Folder của VMware, hoặc
   - Từ PowerShell trên Windows (nếu VM có SSH): `scp server/src/otp.js luno@192.168.209.128:~/smartlocker/`
   - Hoặc trên VM: `mkdir -p ~/smartlocker && nano ~/smartlocker/otp.js`, dán nội dung file vào.
2. Mở cấu hình Node-RED:
   ```bash
   nano ~/.node-red/settings.js
   ```
   Tìm (`Ctrl+W`) chữ `functionGlobalContext`, sửa thành:
   ```js
   functionGlobalContext: {
       otpLib: require('/home/luno/smartlocker/otp.js')
   },
   ```
3. Khởi động lại: `sudo systemctl restart nodered`

Nếu đường dẫn sai, Node-RED sẽ không khởi động – xem lỗi bằng `journalctl -u nodered -n 30`.

## Phần 2 – Kết nối Mosquitto

1. Kéo node **mqtt in** (nhóm network) vào flow, nhấp đúp.
2. Ô **Server** → bấm ✏️ để thêm broker mới:
   - Tab Connection: Server `localhost`, Port `1883`
   - Tab Security: Username `gateway_admin`, Password `123456`
   - Bấm **Add**.
3. Topic: `smartlocker/#`, Output: **a parsed JSON object**.
4. Nối với một node **debug** → **Deploy**.

✅ Kiểm tra: dưới node mqtt in có chấm xanh **connected**. Bật ESP32 trên Wokwi → tab Debug (🐞) thấy tin `status` của tủ.

Xong phần này có thể xóa node debug; các phần sau đều dùng lại broker vừa tạo.

## Phần 3 – Khởi tạo OTP khi Node-RED chạy

Thêm node **inject**:
- Bỏ `msg.payload`/`msg.topic` (không cần), tick **Inject once after 0.1 seconds**, Repeat: `none`.

Nối vào node **function**, đặt tên `Khởi tạo OTP`:

```js
// Tạo dịch vụ OTP: mã 6 số, tự đổi sau 10 phút
const lib = global.get('otpLib');
global.set('otp', lib.createOtpService({ ttlMs: 10 * 60 * 1000 }));
global.set('locker', { online: false, lock: '-', door: '-' });
flow.set('log', []);
node.status({ fill: 'green', shape: 'dot', text: 'OTP sẵn sàng' });
return { payload: { level: 'INFO', event: 'START', details: 'Node-RED khởi động, đã tạo mã OTP' } };
```

(Muốn demo nhanh thì đổi `10 * 60 * 1000` thành `60 * 1000` = 1 phút.)

✅ Deploy → node có chấm xanh "OTP sẵn sàng". Nếu báo lỗi `Cannot read properties of undefined` → Phần 1 chưa đúng.

## Phần 4 – Nhật ký sự kiện

Mọi phần sau đều gửi sự kiện vào node này. Thêm node **function** tên `Ghi nhật ký`:

```js
// msg.payload = { level, event, details }
const log = flow.get('log') || [];
log.unshift({
  'Giờ': new Date().toLocaleTimeString('vi-VN'),
  'Mức': msg.payload.level,
  'Sự kiện': msg.payload.event,
  'Chi tiết': msg.payload.details || ''
});
if (log.length > 50) log.length = 50;
flow.set('log', log);
return { payload: log };
```

Nối đầu ra vào node **ui-table** (nhóm dashboard 2). Mở ui-table → **Group** → ✏️ tạo mới:
- **Page**: ✏️ tạo page `Smart Locker`, path `/locker` (lần đầu sẽ hỏi tạo luôn **UI** base – cứ Add)
- Group name `Nhật ký`, width `12`

Nối thêm đầu ra của `Khởi tạo OTP` (Phần 3) vào `Ghi nhật ký`.

✅ Deploy → mở **http://192.168.209.128:1880/dashboard** → bảng có dòng `START`.

## Phần 5 – Xác thực mã từ ESP32 (phần quan trọng nhất)

```
[mqtt in: verify] → [function: Xác thực OTP] ─(1)→ [mqtt out: verify/result]
                                              └(2)→ [Ghi nhật ký]
```

1. **mqtt in**: topic `smartlocker/locker1/verify`, Output **a parsed JSON object**.
2. **function** `Xác thực OTP`, tab Setup đặt **Outputs = 2**:

```js
// Bỏ qua tin retained (tin cũ lưu trên broker, không phải người vừa nhập)
if (msg.retain) return null;

const otp = global.get('otp');
const d = msg.payload;
if (!d || typeof d !== 'object') {
  return [null, { payload: { level: 'WARN', event: 'INVALID_PAYLOAD', details: 'Payload không phải JSON' } }];
}

const r = otp.verify(d.req, d.code);
if (r === null) return null;                      // req trùng: đã trả lời rồi
if (r.reason === 'INVALID') {
  return [null, { payload: { level: 'WARN', event: 'INVALID_PAYLOAD', details: 'Cần req và mã 6 chữ số' } }];
}

// Chỉ gửi về ESP32 kết quả, KHÔNG BAO GIỜ gửi mã OTP
const { rotated, critical, ...result } = r;

let log;
if (r.ok)                           log = { level: 'SUCCESS',  event: 'OTP_VERIFIED',  details: 'Mã đúng → mở tủ. Mã cũ đã hủy, đã tạo mã mới' };
else if (critical)                  log = { level: 'CRITICAL', event: 'BRUTE_FORCE',   details: 'Sai 5 lần → khóa 5 phút và đổi mã' };
else if (r.reason === 'WRONG')      log = { level: 'WARN',     event: 'OTP_WRONG',     details: `Sai mã, còn ${r.attempts_left} lần` };
else if (r.reason === 'LOCKED_OUT') log = { level: 'WARN',     event: 'KEYPAD_LOCKED', details: `Bàn phím đang khóa, còn ${r.retry_in}s` };
else                                log = { level: 'WARN',     event: 'OTP_NONE',      details: 'Chưa có mã OTP nào hiệu lực' };

return [{ payload: { req: d.req, ...result } }, { payload: log }];
```

3. **mqtt out**: topic `smartlocker/locker1/verify/result`, QoS `0`, Retain `false`.
   (Node-RED tự đổi object thành chuỗi JSON.)
4. Nối đầu ra (2) vào `Ghi nhật ký`.

✅ Kiểm tra: lúc này chưa hiển thị được mã, nhưng nhập bừa `111111` trên keypad Wokwi → OLED "SAI MA! Con 2 lan",
nhật ký có `OTP_WRONG`. Thế là luồng ESP32 → Node-RED → ESP32 đã chạy. Thử mã đúng sau khi làm Phần 6.

## Phần 6 – Hiển thị mã OTP và đếm ngược

```
[inject mỗi 1s] → [function: Cập nhật hiển thị] ─(1)→ ui-text  "Mã OTP"
                                                  ├(2)→ ui-text  "Đổi mã sau"
                                                  ├(3)→ ui-gauge "Thời gian còn lại"
                                                  ├(4)→ ui-text  "Bàn phím"
                                                  ├(5)→ ui-text  "Số lần sai"
                                                  ├(6)→ ui-text  "Mã đã dùng gần nhất"
                                                  └(7)→ Ghi nhật ký
```

1. **inject**: Repeat **interval every 1 seconds**, tick *Inject once after 0.5 seconds*.
2. **function** `Cập nhật hiển thị`, **Outputs = 7**:

```js
const otp = global.get('otp');
if (!otp) return null;

const rotated = otp.tick();          // hết 10 phút → tự tạo mã mới
const s = otp.getState();
const now = Date.now();
const mmss = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');

let left = 0, percent = 0;
if (s.code) {
  left = Math.max(0, Math.ceil((s.expiresAt - now) / 1000));
  percent = Math.round(((s.expiresAt - now) / (s.expiresAt - s.createdAt)) * 100);
}
const lockLeft = Math.ceil((s.lockedUntil - now) / 1000);

return [
  { payload: s.code || 'Chưa có mã' },
  { payload: s.code ? mmss(left) : '--:--' },
  { payload: percent },
  { payload: lockLeft > 0 ? `Bị khóa ${mmss(lockLeft)}` : 'Bình thường' },
  { payload: s.failCount },
  { payload: s.lastUsed ? `${s.lastUsed.code} (đã hủy lúc ${new Date(s.lastUsed.at).toLocaleTimeString('vi-VN')})` : '—' },
  rotated ? { payload: { level: 'INFO', event: 'OTP_ROTATED', details: 'Hết hạn, đã tạo mã mới' } } : null
];
```

3. Các node hiển thị (nhóm dashboard 2). Tạo thêm 2 group trên page `Smart Locker`:
   `Mã OTP` (width 6) và `Bảo mật` (width 3).

| Đầu ra | Node | Cấu hình |
|---|---|---|
| 1 | **ui-text** | Group `Mã OTP`, Label `Mã OTP`, Layout *label above* – vào tab Style chỉnh font to (VD 48px) |
| 2 | **ui-text** | Group `Mã OTP`, Label `Đổi mã sau` |
| 3 | **ui-gauge** | Group `Mã OTP`, Type *half*, Range 0–100, Units `%` |
| 4 | **ui-text** | Group `Bảo mật`, Label `Bàn phím` |
| 5 | **ui-text** | Group `Bảo mật`, Label `Số lần sai liên tiếp` |
| 6 | **ui-text** | Group `Mã OTP`, Label `Mã đã dùng gần nhất` |
| 7 | → `Ghi nhật ký` | |

✅ Deploy → dashboard hiện mã 6 số, đếm ngược giảm từng giây. Giờ quay lại kiểm tra Phần 5 với Wokwi:
- Nhập đúng → mã đổi ngay, "Mã đã dùng gần nhất" hiện mã cũ.
- Nhập lại mã cũ → OLED "SAI MA! Con 2 lan", "Số lần sai" = 1.
- Sai tiếp 2 lần → "Bàn phím: Bị khóa 0:30".

## Phần 7 – Trạng thái tủ (online / khóa / cửa)

```
[mqtt in: status] → [function: Trạng thái tủ] ─(1)→ ui-text "Kết nối"
                                                ├(2)→ ui-text "Khóa"
                                                ├(3)→ ui-text "Cửa"
                                                └(4)→ Ghi nhật ký
```

1. **mqtt in**: topic `smartlocker/locker1/status`, Output **a parsed JSON object**.
   (Topic này *retained* nên vừa Deploy là có ngay trạng thái mới nhất.)
2. **function** `Trạng thái tủ`, **Outputs = 4**:

```js
const d = msg.payload || {};
const L = global.get('locker');
const wasOnline = L.online;

L.online = d.online === true;
if (typeof d.lock === 'string') L.lock = d.lock;
if (typeof d.door === 'string') L.door = d.door;

const TEXT = { LOCKED: 'Đã khóa', UNLOCKED: 'Đang mở', OPEN: 'Mở', CLOSED: 'Đóng' };
const log = wasOnline === L.online ? null : {
  payload: L.online
    ? { level: 'INFO', event: 'LOCKER_ONLINE', details: 'Tủ đã kết nối broker' }
    : { level: 'WARN', event: 'LOCKER_OFFLINE', details: 'Tủ mất kết nối broker' }
};

return [
  { payload: L.online ? 'Online' : 'Offline' },
  { payload: TEXT[L.lock] || '–' },
  { payload: TEXT[L.door] || '–' },
  log
];
```

3. 3 node **ui-text** trong group mới `Trạng thái tủ` (width 3): Label `Kết nối`, `Khóa`, `Cửa`.

✅ Tắt Wokwi → sau khoảng 15 giây (Last Will) "Kết nối" chuyển `Offline`, nhật ký có `LOCKER_OFFLINE`.

## Phần 8 – Sự kiện cửa & cảnh báo cạy cửa

```
[mqtt in: events] → [function: Sự kiện tủ] ─(1)→ Ghi nhật ký
                                             └(2)→ ui-notification
```

1. **mqtt in**: topic `smartlocker/locker1/events`, Output **a parsed JSON object**.
2. **function** `Sự kiện tủ`, **Outputs = 2**:

```js
const d = msg.payload || {};
if (typeof d.event !== 'string') return null;

if (d.event === 'TAMPER') {
  return [
    { payload: { level: 'CRITICAL', event: 'TAMPER', details: 'Cửa bị mở khi đang khóa – nghi cạy cửa!' } },
    { payload: '⚠️ CẢNH BÁO: Cửa tủ bị mở trái phép!' }
  ];
}
return [{ payload: { level: 'INFO', event: d.event, details: d.source ? `Nguồn: ${d.source}` : '' } }, null];
```

3. **ui-notification**: UI = base vừa tạo, Position *top right*, Timeout `5`, màu đỏ.

✅ Trên Wokwi gạt công tắc cửa khi tủ đang khóa → còi kêu, dashboard bật thông báo đỏ, nhật ký có `TAMPER`.

## Phần 9 – Các nút điều khiển

Tạo group `Điều khiển` (width 3). Thêm 4 node **ui-button**, mỗi nút nối vào 1 function:

| Nút | Function | Code |
|---|---|---|
| `Tạo mã mới` | `Tạo mã` | `global.get('otp').rotate();`<br>`return { payload: { level: 'INFO', event: 'OTP_CREATED', details: 'Admin tạo mã mới' } };` |
| `Hủy mã` | `Hủy mã` | `global.get('otp').revoke();`<br>`return { payload: { level: 'WARN', event: 'OTP_REVOKED', details: 'Admin hủy mã – chờ tạo mã mới' } };` |
| `Gỡ khóa bàn phím` | `Gỡ khóa` | `global.get('otp').clearLockout();`<br>`return { payload: { level: 'INFO', event: 'LOCKOUT_CLEARED', details: 'Admin gỡ khóa bàn phím' } };` |
| `Mở khóa từ xa` | `Mở từ xa` (**Outputs = 2**) | xem dưới |

Đầu ra của 3 function đầu nối vào `Ghi nhật ký`.

Function `Mở từ xa`:

```js
return [
  { payload: { cmd: 'UNLOCK' } },
  { payload: { level: 'INFO', event: 'REMOTE_UNLOCK', details: 'Admin gửi lệnh mở khóa từ xa' } }
];
```

- Đầu ra (1) → **mqtt out** topic `smartlocker/locker1/command`, Retain `false`
  (**không** được retain, nếu không tủ sẽ tự mở mỗi lần kết nối lại).
- Đầu ra (2) → `Ghi nhật ký`.

✅ Bấm "Mở khóa từ xa" → relay trên Wokwi mở, OLED "MOI MO CUA".
Bấm "Hủy mã" → dashboard "Chưa có mã"; nhập mã trên keypad → OLED "Chua co ma OTP".

---

## Kiểm tra không cần Wokwi

Từ Windows (thư mục dự án, cần `server/.env` có `MQTT_URL` đúng IP VM, đã `npm install` trong `server`):

```bash
node tools/fake-locker.js 123456     # gửi mã, in kết quả từ Node-RED
node tools/fake-locker.js --listen   # đóng vai tủ, in lệnh UNLOCK khi bấm nút
```

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| node mqtt báo `disconnected` | Sai user/pass ở broker config, hoặc Mosquitto chưa chạy (`systemctl status mosquitto`) |
| `Cannot read properties of undefined (reading 'createOtpService')` | Phần 1 chưa đúng: sai đường dẫn `require` hoặc chưa restart Node-RED |
| `Cannot read properties of undefined (reading 'verify')` | Chưa Deploy Phần 3, hoặc vừa restart mà node inject Phần 3 chưa tick *Inject once* |
| OLED "Mat ket noi may chu" dù ONLINE | Flow Phần 5 chưa Deploy / mqtt out sai topic `verify/result` |
| Nhập đúng nhưng báo sai liên tục | Server Node.js (`npm start`) cũng đang chạy → tắt nó đi |
| Dashboard trắng | Mở đúng `http://<IP VM>:1880/dashboard`, kiểm tra đã cài `@flowfuse/node-red-dashboard` |

## Xuất flow để nộp

☰ → **Export** → *all flows* → **Download** → lưu thành `docs/node-red/flows.json` trong dự án.
Lần sau chỉ cần ☰ → **Import** file đó (vẫn phải làm Phần 0 và Phần 1 trên máy mới).
