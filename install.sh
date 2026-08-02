#!/usr/bin/env bash
# 3xUI Lite Agent Panel 一键安装脚本
set -Eeuo pipefail

REPOSITORY="${REPOSITORY:-https://github.com/binshao1230/3xui-lite-agent-panel}"
BRANCH="${BRANCH:-}"
if [[ -n "${REF:-}" ]]; then
  SOURCE_REF="${REF}"
elif [[ -n "${BRANCH}" ]]; then
  SOURCE_REF="refs/heads/${BRANCH}"
else
  SOURCE_REF="refs/tags/v0.7.2"
fi
ARCHIVE_URL="${REPOSITORY%/}/archive/${SOURCE_REF}.tar.gz"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 180 "${ARCHIVE_URL}" -o "${TMP_DIR}/source.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -q --timeout=30 --tries=3 -O "${TMP_DIR}/source.tar.gz" "${ARCHIVE_URL}"
else
  echo "需要安装 curl 或 wget。"
  exit 1
fi

if [[ -n "${SOURCE_SHA256:-}" ]]; then
  if ! [[ "${SOURCE_SHA256}" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    echo "SOURCE_SHA256 必须是 64 位十六进制 SHA-256。"
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "${SOURCE_SHA256}" "${TMP_DIR}/source.tar.gz" | sha256sum -c -
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha256="$(shasum -a 256 "${TMP_DIR}/source.tar.gz" | awk '{print $1}')"
    if [[ "${actual_sha256,,}" != "${SOURCE_SHA256,,}" ]]; then echo "源码包 SHA-256 校验失败。"; exit 1; fi
  else
    echo "已提供 SOURCE_SHA256，但系统没有 sha256sum 或 shasum。"
    exit 1
  fi
fi

mkdir -p "${TMP_DIR}/source"
tar -xzf "${TMP_DIR}/source.tar.gz" --strip-components=1 -C "${TMP_DIR}/source"
bash "${TMP_DIR}/source/deploy-linux.sh"