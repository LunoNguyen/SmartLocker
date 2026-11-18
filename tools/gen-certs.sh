#!/usr/bin/env bash
# Tạo chứng chỉ TLS cho Mosquitto (MQTT over TLS, cổng 8883).
#
#   bash tools/gen-certs.sh [IP_BROKER]        (mặc định 192.168.209.128)
#
# Chạy được trên Windows (Git Bash) lẫn Ubuntu. Tạo ra:
#   mosquitto/certs/ca.crt       CA của nhóm  -> web server + ESP32 dùng để kiểm tra broker
#   mosquitto/certs/ca.key       khóa CA      -> giữ kín, chỉ dùng khi tạo lại chứng chỉ
#   mosquitto/certs/server.crt   chứng chỉ broker (CN + SAN = IP broker)
#   mosquitto/certs/server.key   khóa broker  -> copy sang VM cùng server.crt
#   include/ca_cert.h            CA dạng chuỗi C cho firmware ESP32
#
# Đổi IP máy ảo thì chạy lại script với IP mới, build lại firmware và copy lại certs sang VM.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: không đổi "/CN=..." thành đường dẫn Windows

IP="${1:-192.168.209.128}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/mosquitto/certs"
HDR="$ROOT/include/ca_cert.h"
mkdir -p "$OUT"
cd "$OUT"

if [[ ! "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "IP không hợp lệ: $IP" >&2
  exit 1
fi

# 1) CA (giữ lại nếu đã có, để không phải build lại firmware khi chỉ đổi IP)
if [[ ! -f ca.key || ! -f ca.crt ]]; then
  echo "[1/3] Tạo CA mới"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout ca.key -out ca.crt -subj "/CN=SmartLocker Nhom6 CA/O=Nhom 6" 2>/dev/null
else
  echo "[1/3] Dùng lại CA có sẵn"
fi

# 2) Chứng chỉ broker. SAN có cả IP (Node.js kiểm tra) lẫn DNS (mbedTLS trên ESP32 so khớp dạng chuỗi)
echo "[2/3] Tạo chứng chỉ broker cho $IP"
cat > server.ext <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:$IP, DNS:$IP
EOF
openssl req -newkey rsa:2048 -nodes -sha256 -keyout server.key -out server.csr -subj "/CN=$IP/O=Nhom 6" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 \
  -extfile server.ext -out server.crt 2>/dev/null
rm -f server.csr server.ext ca.srl
openssl verify -CAfile ca.crt server.crt

# 3) CA cho firmware
echo "[3/3] Ghi $HDR"
{
  echo "// Tạo tự động bởi tools/gen-certs.sh - KHÔNG sửa tay."
  echo "// Chứng chỉ CA dùng để ESP32 kiểm tra broker Mosquitto (MQTT over TLS)."
  echo "#pragma once"
  echo "static const char CA_CERT[] ="
  sed -e 's/\r$//' -e 's/^/  "/' -e 's/$/\\n"/' ca.crt
  echo "  ;"
} > "$HDR"

echo
echo "Xong. Chứng chỉ broker dùng cho: $IP"
echo "  - Copy mosquitto/certs/ca.crt, server.crt, server.key sang VM (cùng thư mục mosquitto/), chạy lại setup_mosquitto.sh"
echo "  - Build lại firmware ESP32 (include/ca_cert.h đã cập nhật)"
