// Tạo database nhật ký Smart Locker: 2 collection + ràng buộc schema + index.
// Chạy lại nhiều lần vẫn an toàn (collection đã có thì chỉ cập nhật schema/index).
//
//   cd server && npm run init-db

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/smartlockerlogs';

const dateOrNull = { bsonType: ['date', 'null'] };

const COLLECTIONS = {
  // Mỗi lần mở khóa = 1 bản ghi
  access_logs: {
    schema: {
      bsonType: 'object',
      required: ['unlockedAt', 'method', 'status'],
      properties: {
        unlockedAt: { bsonType: 'date', description: 'Thời điểm mở khóa' },
        method: { enum: ['OTP', 'REMOTE'], description: 'Cách mở: nhập OTP hoặc admin mở từ xa' },
        failedAttemptsBefore: { bsonType: 'int', minimum: 0, description: 'Số lần nhập sai ngay trước lần mở này' },
        doorOpenedAt: dateOrNull,
        doorClosedAt: dateOrNull,
        openDurationSec: { bsonType: ['int', 'null'], minimum: 0, description: 'Thời lượng mở cửa (giây); null = không mở cửa' },
        lockedAt: dateOrNull,
        lockReason: { enum: ['DOOR_CLOSED', 'TIMEOUT', 'UNKNOWN', null], description: 'Cách khóa lại' },
        status: { enum: ['IN_PROGRESS', 'DONE'] },
        anomalies: { bsonType: 'array', items: { bsonType: 'string' } }
      }
    },
    indexes: [
      { key: { unlockedAt: -1 }, name: 'unlockedAt_desc' },
      { key: { method: 1, unlockedAt: -1 }, name: 'method_unlockedAt' }
    ]
  },

  // Danh sách bất thường cần admin xem xét
  anomalies: {
    schema: {
      bsonType: 'object',
      required: ['type', 'severity', 'message', 'at', 'resolved'],
      properties: {
        type: {
          enum: ['TAMPER', 'BRUTE_FORCE_WARN', 'BRUTE_FORCE_LOCK', 'DOOR_AJAR',
            'AFTER_HOURS', 'FREQUENT_UNLOCK', 'LOCKER_OFFLINE']
        },
        severity: { enum: ['WARN', 'CRITICAL'] },
        message: { bsonType: 'string' },
        at: { bsonType: 'date' },
        accessLogId: { bsonType: ['objectId', 'null'] },
        resolved: { bsonType: 'bool' },
        resolvedAt: dateOrNull
      }
    },
    indexes: [
      { key: { at: -1 }, name: 'at_desc' },
      { key: { resolved: 1, at: -1 }, name: 'resolved_at' }
    ]
  }
};

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  const db = client.db();
  console.log(`Database: ${db.databaseName} (${URI})`);

  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const [name, { schema, indexes }] of Object.entries(COLLECTIONS)) {
    if (existing.has(name)) {
      await db.command({ collMod: name, validator: { $jsonSchema: schema }, validationLevel: 'moderate' });
      console.log(`  ~ ${name}: đã có, cập nhật schema`);
    } else {
      await db.createCollection(name, { validator: { $jsonSchema: schema }, validationLevel: 'moderate' });
      console.log(`  + ${name}: đã tạo`);
    }
    await db.collection(name).createIndexes(indexes);
    console.log(`    index: ${indexes.map((i) => i.name).join(', ')}`);
  }

  await client.close();
  console.log('Xong.');
}

main().catch((err) => {
  console.error('Lỗi:', err.message);
  console.error('Kiểm tra MongoDB đã chạy chưa (services.msc → MongoDB) và MONGODB_URI trong server/.env');
  process.exit(1);
});
