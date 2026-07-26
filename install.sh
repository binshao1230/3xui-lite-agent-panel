#!/usr/bin/env bash
# 3xUI Lite Agent Panel 一键安装脚本
set -Eeuo pipefail

REPOSITORY="${REPOSITORY:-https://github.com/binshao1230/3xui-lite-agent-panel}"
BRANCH="${BRANCH:-main}"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${REPOSITORY}/archive/refs/heads/${BRANCH}.tar.gz" -o "${TMP_DIR}/source.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "${TMP_DIR}/source.tar.gz" "${REPOSITORY}/archive/refs/heads/${BRANCH}.tar.gz"
else
  echo "需要安装 curl 或 wget。"
  exit 1
fi

mkdir -p "${TMP_DIR}/source"
tar -xzf "${TMP_DIR}/source.tar.gz" --strip-components=1 -C "${TMP_DIR}/source"
bash "${TMP_DIR}/source/deploy-linux.sh"