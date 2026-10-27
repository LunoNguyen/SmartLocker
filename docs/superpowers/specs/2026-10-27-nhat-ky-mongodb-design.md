# Nhật ký mở khóa & kiểm soát bất thường (MongoDB)

Ngày: 2026-10-27 · Nhóm 6 · Trạng thái: đã duyệt trong chat

## Mục tiêu

Lưu mỗi lần mở tủ vào MongoDB (thời điểm, cách mở, thời lượng mở cửa...) và phát hiện bất thường.
Web có tab xem nhật ký (lọc, phân trang, xuất CSV) và tab bất thường (đánh dấu đã xử lý).

## Quyết định

- Web Node.js (`server/`), không dùng Node-RED cho phần này.
- MongoDB Community cài trên Windows, `MONGODB_URI=mongodb://127.0.0.1:27017/smartlockerlogs`.
- Lưu vĩnh viễn, không TTL.
- **Firmware không đổi**: server ghép phiên mở khóa từ các sự kiện ESP32 đã gửi
  (`UNLOCKED`, `DOOR_OPENED`, `DOOR_CLOSED`, `LOCKED`, `TAMPER`, `status`).
- Không lưu mã OTP vào DB.
- MongoDB tắt → OTP vẫn hoạt động; web hiện thanh vàng "Mất kết nối MongoDB".

## Dữ liệu

Database `smartlockerlogs` (tạo bằng `npm run init-db`, có `$jsonSchema`).

`access_logs`: `unlockedAt`, `method` (`OTP`|`REMOTE`), `failedAttemptsBefore`, `doorOpenedAt`, `doorClosedAt`,
`openDurationSec` (null = không mở cửa), `lockedAt`, `lockReason` (`DOOR_CLOSED`|`TIMEOUT`|`UNKNOWN`),
`status` (`IN_PROGRESS`|`DONE`), `anomalies` (mảng loại bất thường gắn với lần mở).

`anomalies`: `type`, `severity` (`WARN`|`CRITICAL`), `message`, `at`, `accessLogId`, `resolved`, `resolvedAt`.

## Bất thường

| Loại | Điều kiện | Mức | Ngưỡng `.env` |
|---|---|---|---|
| `TAMPER` | Sự kiện TAMPER từ tủ | CRITICAL | – |
| `BRUTE_FORCE_WARN` | Lần sai làm bắt đầu khóa 30 s | WARN | – |
| `BRUTE_FORCE_LOCK` | Sai 5 lần, khóa 5 phút | CRITICAL | – |
| `DOOR_AJAR` | Cửa mở trong phiên ≥ N giây (báo 1 lần/phiên) | WARN | `DOOR_AJAR_SEC=60` |
| `AFTER_HOURS` | Mở khóa trong khung giờ đêm | WARN | `AFTER_HOURS_START=23`, `AFTER_HOURS_END=5` |
| `FREQUENT_UNLOCK` | > N lần mở trong M phút (báo tối đa 1 lần/M phút) | WARN | `FREQUENT_UNLOCK_COUNT=5`, `FREQUENT_UNLOCK_WINDOW_MIN=10` |
| `LOCKER_OFFLINE` | Status `online:false` kéo dài ≥ N phút (1 lần/đợt) | WARN | `OFFLINE_ALERT_MIN=2` |

`otp.verify` trả thêm cờ nội bộ `lockStarted` khi chính lần sai này bắt đầu khóa (bridge không gửi cờ này về ESP32).

## Thành phần

- `server/src/accessTracker.js` – logic thuần (now() tiêm vào), ghép phiên + phát hiện bất thường, ghi qua `store`, ghi tuần tự.
- `server/src/store.js` – `createMemoryStore()` (test) và `createMongoStore(uri)` (ping 5 s, tự nối lại).
- `server/src/app.js` – tạo express app từ các dependency (để test API); `index.js` chỉ nối.
- API: `GET /api/access-logs?from&to&method&page`, `GET /api/access-logs.csv`, `GET /api/anomalies?status=open|all&page`,
  `POST /api/anomalies/:id/resolve`; `/api/state` thêm `db.connected`, `anomalies.unresolved`, `logsVersion`.
- Web: 3 tab Điều khiển / Nhật ký mở khóa / Bất thường; badge số bất thường chưa xử lý; toast khi có bất thường mới.

## Kiểm thử

Unit test tracker (fake clock + memory store), test store bộ nhớ, test API qua `app.listen(0)` + `fetch`,
kiểm tra tích hợp với MongoDB thật bằng `fake-locker` / Wokwi.
