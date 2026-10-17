#!/usr/bin/env bash
# Cai dat & cau hinh Mosquitto cho Smart Locker tren Ubuntu
# Chay: sudo bash setup_mosquitto.sh
set -e

MQTT_USER="gateway_admin"
MQTT_PASS="123456"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$EUID" -ne 0 ]; then
  echo "Hay chay bang sudo: sudo bash $0"
  exit 1
fi

# 1. Cai mosquitto neu chua co
if ! command -v mosquitto >/dev/null 2>&1 || ! command -v mosquitto_pub >/dev/null 2>&1; then
  echo "[1/5] Cai dat mosquitto + mosquitto-clients..."
  apt-get update
  apt-get install -y mosquitto mosquitto-clients
else
  echo "[1/5] Mosquitto da duoc cai."
fi

# 2. Tao file password
echo "[2/5] Tao user MQTT: $MQTT_USER"
mosquitto_passwd -c -b /etc/mosquitto/passwd "$MQTT_USER" "$MQTT_PASS"
chown mosquitto:mosquitto /etc/mosquitto/passwd
chmod 600 /etc/mosquitto/passwd

# 3. Copy config
echo "[3/5] Copy smartlocker.conf -> /etc/mosquitto/conf.d/"
cp "$SCRIPT_DIR/smartlocker.conf" /etc/mosquitto/conf.d/smartlocker.conf

# 4. Mo firewall (neu ufw dang bat)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "[4/5] Mo cong 1883 tren ufw"
  ufw allow 1883/tcp
else
  echo "[4/5] ufw khong bat, bo qua."
fi

# 5. Khoi dong lai
echo "[5/5] Khoi dong lai mosquitto"
systemctl enable mosquitto >/dev/null 2>&1 || true
systemctl restart mosquitto
sleep 1
systemctl --no-pager --lines=5 status mosquitto || true

echo
echo "==================================================="
echo " Mosquitto dang nghe tai:"
ss -ltnp | grep 1883 || true
echo
echo " IP cua may ao (dien vao MQTT_BROKER_HOST trong include/config.h):"
hostname -I
echo "==================================================="
