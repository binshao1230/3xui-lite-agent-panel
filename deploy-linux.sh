#!/usr/bin/env bash
# 3xUI Lite Linux 安装脚本（systemd）
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 sudo 运行：sudo bash ./deploy-linux.sh"
  exit 1
fi

command_exists() { command -v "$1" >/dev/null 2>&1; }
install_node() {
  if command_exists node && command_exists npm; then
    local current
    current="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "${current}" -ge 18 ]]; then return; fi
  fi
  echo "正在安装 Node.js 20 LTS..."
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
    echo "未找到受支持的软件包管理器。请手动安装 Node.js 18 或更高版本后重新运行。"
    exit 1
  fi
}

ensure_unzip() {
  if command_exists unzip; then return; fi
  echo "正在安装 unzip..."
  if command_exists apt-get; then apt-get update; apt-get install -y unzip;
  elif command_exists dnf; then dnf install -y unzip;
  elif command_exists yum; then yum install -y unzip;
  elif command_exists apk; then apk add --no-cache unzip;
  else echo "未找到受支持的软件包管理器，请手动安装 unzip 后重试。"; exit 1; fi
}
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/3xui-lite-agent-panel}"
SERVICE_NAME="${SERVICE_NAME:-3xui-lite-agent-panel}"
install_node
ensure_unzip
if ! command_exists npm; then
  echo "未找到 npm。请安装与 Node.js 配套的 npm 后重新运行。"
  exit 1
fi
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NODE_MAJOR="$(${NODE_BIN} -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "需要 Node.js 18 或更高版本；当前版本为 $(${NODE_BIN} --version)。"
  exit 1
fi

install -d -m 0750 "${APP_DIR}"
tar -C "${SOURCE_DIR}" \
  --exclude=.git --exclude=node_modules --exclude=runtime --exclude=release \
  --exclude=settings.json --exclude=users.json --exclude=inbounds.json --exclude=relays.json \
  --exclude=agents.json --exclude=traffic.json --exclude=audit.json --exclude=runtime-xray.json --exclude=agent-xray-config.json \
  -cf - . | tar -C "${APP_DIR}" -xf -

cd "${APP_DIR}"
npm ci --omit=dev --no-audit --no-fund
chmod 0750 "${APP_DIR}"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=3xUI Lite Agent 管理面板
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT:-3000}
Environment=PANEL_HOST=${PANEL_HOST:-0.0.0.0}
Environment=SECURE_COOKIE=${SECURE_COOKIE:-false}
Environment=TRUST_PROXY=${TRUST_PROXY:-false}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5
UMask=0077
PrivateTmp=true
ProtectHome=true
ProtectKernelTunables=true
NoNewPrivileges=true
ProtectControlGroups=true
ProtectKernelModules=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitNOFILE=65536
TasksMax=512
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
systemctl --no-pager --full status "${SERVICE_NAME}"

echo
echo "安装完成。面板监听：${PANEL_HOST:-0.0.0.0}:${PORT:-3000}"
echo "生产环境请仅允许管理 IP 或反向代理访问面板端口，并优先通过 HTTPS 访问。"
echo "首次登录账号密码为 admin / admin；面板会强制修改密码后才允许管理操作。"
