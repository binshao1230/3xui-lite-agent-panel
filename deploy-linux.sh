#!/usr/bin/env bash
# 3xUI Lite Linux installer (systemd)
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo: sudo ./deploy-linux.sh"
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/3xui-lite}"
SERVICE_NAME="${SERVICE_NAME:-3xui-lite}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "Node.js 18+ is required. Install Node.js first, then run this script again."
  exit 1
fi

NODE_MAJOR="$(${NODE_BIN} -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "Node.js 18+ is required; found $(${NODE_BIN} --version)."
  exit 1
fi

install -d -m 0750 "${APP_DIR}"
tar -C "${SOURCE_DIR}" \
  --exclude=.git --exclude=node_modules --exclude=runtime --exclude=release \
  --exclude=settings.json --exclude=users.json --exclude=inbounds.json --exclude=relays.json \
  --exclude=agents.json --exclude=traffic.json --exclude=runtime-xray.json --exclude=agent-xray-config.json \
  -cf - . | tar -C "${APP_DIR}" -xf -

cd "${APP_DIR}"
npm ci --omit=dev
chmod 0750 "${APP_DIR}"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=3xUI Lite Control Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT:-3000}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
systemctl --no-pager --full status "${SERVICE_NAME}"

echo
echo "Installed. Open: http://SERVER_IP:${PORT:-3000}"
echo "Default first-login credentials are admin / admin; change the password immediately."