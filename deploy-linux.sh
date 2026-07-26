#!/usr/bin/env bash
# 3xUI Lite Linux installer (systemd)
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run with sudo: sudo bash ./deploy-linux.sh"
  exit 1
fi

command_exists() { command -v "$1" >/dev/null 2>&1; }
install_node() {
  if command_exists node; then
    local current
    current="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "${current}" -ge 18 ]]; then return; fi
  fi
  echo "Installing Node.js 20 LTS..."
  if command_exists apt-get; then
    apt-get update
    apt-get install -y ca-certificates curl
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command_exists dnf; then
    dnf install -y ca-certificates curl
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  elif command_exists yum; then
    yum install -y ca-certificates curl
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  elif command_exists apk; then
    apk add --no-cache nodejs npm
  else
    echo "No supported package manager found. Install Node.js 18+ manually and rerun."
    exit 1
  fi
}

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/3xui-lite-agent-panel}"
SERVICE_NAME="${SERVICE_NAME:-3xui-lite-agent-panel}"
install_node
NODE_BIN="${NODE_BIN:-$(command -v node)}"
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
npm ci --omit=dev --no-audit --no-fund
chmod 0750 "${APP_DIR}"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=3xUI Lite Agent Panel
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