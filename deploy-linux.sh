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
    case "${current}" in 22|24) return ;; esac
  fi
  echo "正在安装 Node.js 24 LTS..."
  if command_exists apt-get; then
    apt-get update
    apt-get install -y ca-certificates curl
    curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused --connect-timeout 10 --max-time 180 https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
  elif command_exists dnf; then
    dnf install -y ca-certificates curl
    curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused --connect-timeout 10 --max-time 180 https://rpm.nodesource.com/setup_24.x | bash -
    dnf install -y nodejs
  elif command_exists yum; then
    yum install -y ca-certificates curl
    curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused --connect-timeout 10 --max-time 180 https://rpm.nodesource.com/setup_24.x | bash -
    yum install -y nodejs
  elif command_exists apk; then
    apk add --no-cache nodejs npm
  else
    echo "未找到受支持的软件包管理器。请手动安装 Node.js 22 LTS 或 24 LTS 后重新运行。"
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
if ! [[ "${SERVICE_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]]; then
  echo "SERVICE_NAME 必须以字母或数字开头，且只能包含字母、数字、点、下划线、@ 和连字符。"
  exit 1
fi
if [[ "${APP_DIR}" != /* || "${APP_DIR}" =~ [[:cntrl:]] ]]; then
  echo "APP_DIR 必须是不含控制字符的绝对路径。"
  exit 1
fi
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
if [[ -L "${UNIT_FILE}" || ( -e "${UNIT_FILE}" && ! -f "${UNIT_FILE}" ) ]]; then
  echo "现有 systemd 单元必须是普通文件，不能是符号链接或特殊文件：${UNIT_FILE}"
  exit 1
fi

read_unit_environment() {
  local key="$1"
  [[ -f "${UNIT_FILE}" ]] || return 0
  sed -n "s/^Environment=${key}=//p" "${UNIT_FILE}" | tail -n 1
}

# Re-running the installer is an upgrade. Keep the previous network/security
# settings unless the operator explicitly supplies replacements.
PORT_VALUE="${PORT:-$(read_unit_environment PORT)}"
PANEL_HOST_VALUE="${PANEL_HOST:-$(read_unit_environment PANEL_HOST)}"
SECURE_COOKIE_VALUE="${SECURE_COOKIE:-$(read_unit_environment SECURE_COOKIE)}"
TRUST_PROXY_VALUE="${TRUST_PROXY:-$(read_unit_environment TRUST_PROXY)}"
PORT_VALUE="${PORT_VALUE:-3000}"
PANEL_HOST_VALUE="${PANEL_HOST_VALUE:-0.0.0.0}"
SECURE_COOKIE_VALUE="${SECURE_COOKIE_VALUE:-false}"
TRUST_PROXY_VALUE="${TRUST_PROXY_VALUE:-false}"

if ! [[ "${PORT_VALUE}" =~ ^[0-9]+$ ]] || (( 10#${PORT_VALUE} < 1 || 10#${PORT_VALUE} > 65535 )); then
  echo "PORT 必须是 1 到 65535 之间的整数。"
  exit 1
fi
if ! [[ "${PANEL_HOST_VALUE}" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  echo "PANEL_HOST 包含不支持的字符。"
  exit 1
fi
if [[ "${SECURE_COOKIE_VALUE}" != "true" && "${SECURE_COOKIE_VALUE}" != "false" ]]; then
  echo "SECURE_COOKIE 只能设置为 true 或 false。"
  exit 1
fi
if [[ "${TRUST_PROXY_VALUE}" != "true" && "${TRUST_PROXY_VALUE}" != "false" ]]; then
  echo "TRUST_PROXY 只能设置为 true 或 false。"
  exit 1
fi
install_node
ensure_unzip
if ! command_exists npm; then
  echo "未找到 npm。请安装与 Node.js 配套的 npm 后重新运行。"
  exit 1
fi
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NODE_MAJOR="$("${NODE_BIN}" -p "process.versions.node.split('.')[0]")"
case "${NODE_MAJOR}" in
  22|24) ;;
  *)
    echo "需要仍受支持的 Node.js 22 LTS 或 24 LTS；当前版本为 $("${NODE_BIN}" --version)。"
    exit 1
    ;;
esac

canonicalize_app_dir() {
  "${NODE_BIN}" - "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path').posix;
const raw = process.argv[2] || '';
const invalidCharacter = /["\\\u0000-\u001f\u007f]/;
if (!raw.startsWith('/') || invalidCharacter.test(raw) || raw.split('/').some(part => part === '.' || part === '..')) process.exit(2);
const normalized = path.resolve(raw);
function maybeLstat(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; }
}
const rootStat = fs.lstatSync('/');
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0 || rootStat.gid !== 0 || (rootStat.mode & 0o022) !== 0) process.exit(8);
let cursor = '/';
for (const part of normalized.split('/').filter(Boolean)) {
  const candidate = path.join(cursor, part);
  const info = maybeLstat(candidate);
  if (!info) break;
  if (info.isSymbolicLink() || !info.isDirectory()) process.exit(3);
  if (info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022) !== 0) process.exit(8);
  cursor = candidate;
}
const canonical = normalized;
const exactProtected = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/sys', '/tmp', '/usr', '/var', '/opt']);
const protectedTree = /^(?:\/(?:bin|boot|dev|etc|home|proc|root|run|sbin|sys|tmp|usr))(?:\/|$)|^\/lib[^/]*(?:\/|$)/;
const dangerous = target => exactProtected.has(target) || protectedTree.test(target);
if (dangerous(canonical) || invalidCharacter.test(canonical)) process.exit(7);
process.stdout.write(canonical);
NODE
}
if ! APP_DIR_RESOLVED="$(canonicalize_app_dir "${APP_DIR}")"; then
  echo "APP_DIR 必须位于逐级由 root 所有且不可由组/其他用户写入的独立目录中；不能使用符号链接、根/关键系统目录、引号、反斜杠或 . / .. 路径段。"
  exit 1
fi
APP_DIR="${APP_DIR_RESOLVED}"

SENSITIVE_DATA_NAMES=(settings.json users.json inbounds.json relays.json agents.json traffic.json audit.json runtime-xray.json agent-xray-config.json .3xui-lite-agent-state.json)
validate_existing_data() {
  "${NODE_BIN}" - "${APP_DIR}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const arrayFiles = new Set(['users.json', 'inbounds.json', 'relays.json', 'agents.json', 'traffic.json', 'audit.json']);
const objectFiles = new Set(['runtime-xray.json', 'agent-xray-config.json', '.3xui-lite-agent-state.json']);
const names = ['settings.json', ...arrayFiles, ...objectFiles];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validAdmin = admin => {
  if (!isObject(admin) || typeof admin.salt !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(admin.salt) || typeof admin.hash !== 'string') return false;
  const decoded = Buffer.from(admin.hash, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === admin.hash;
};
function invalid(name, reason) { console.error(name + ': ' + reason); process.exit(2); }
for (const name of names) {
  const file = path.join(root, name);
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') continue;
    invalid(name, '无法检查文件类型');
  }
  if (info.isSymbolicLink() || !info.isFile()) invalid(name, '必须是普通文件，不能是符号链接、目录或特殊文件');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { invalid(name, '不是有效的 JSON'); }
  if (arrayFiles.has(name) && !Array.isArray(value)) invalid(name, '顶层值必须是数组');
  if (objectFiles.has(name) && !isObject(value)) invalid(name, '顶层值必须是对象');
  if (name === 'settings.json' && (!isObject(value) || !validAdmin(value.admin))) {
    invalid(name, '必须包含有效的 admin.salt 和 admin.hash');
  }
}
NODE
}
if ! validate_existing_data; then
  echo "现有运行数据预检失败；部署尚未覆盖应用文件，也不会重启服务。"
  exit 1
fi

# Build and validate in a temporary directory first. A dependency or syntax
# failure therefore cannot mutate the currently running installation.
STAGE_DIR="$(mktemp -d)"
TOP_LEVEL_MANIFEST=""
MODULES_NEXT=""
MODULES_OLD=""
MODULES_SWITCHED=false
SOURCE_BACKUP=""
SOURCE_TRANSACTION_ACTIVE=false
SOURCE_OVERLAY_STARTED=false
UNIT_BACKUP=""
UNIT_NEXT=""
UNIT_WRITTEN=false
SERVICE_RESTART_ATTEMPTED=false
SERVICE_WAS_ENABLED=false
SERVICE_WAS_ACTIVE=false
INITIAL_SETTINGS_CREATED=false
INITIAL_ADMIN_PASSWORD=""
APP_DIR_METADATA=""
SENSITIVE_METADATA=()
PUBLISHED_TOP_LEVEL=()
BACKED_UP_TOP_LEVEL=()

if systemctl is-enabled "${SERVICE_NAME}" >/dev/null 2>&1; then SERVICE_WAS_ENABLED=true; fi
if systemctl is-active "${SERVICE_NAME}" >/dev/null 2>&1; then SERVICE_WAS_ACTIVE=true; fi
if [[ -d "${APP_DIR}" ]]; then APP_DIR_METADATA="$(stat -c '%u:%g:%a' -- "${APP_DIR}")"; fi
for data_name in "${SENSITIVE_DATA_NAMES[@]}"; do
  data_path="${APP_DIR}/${data_name}"
  if [[ -f "${data_path}" && ! -L "${data_path}" ]]; then
    SENSITIVE_METADATA+=("${data_name}:$(stat -c '%u:%g:%a' -- "${data_path}")")
  fi
done

# Delete a path without following symbolic links or descending into another
# filesystem. A nested mount therefore makes cleanup fail closed.
remove_path_no_cross() {
  local target="$1"
  local failed=0
  [[ -e "${target}" || -L "${target}" ]] || return 0
  if [[ -L "${target}" || ! -d "${target}" ]]; then
    rm -f -- "${target}"
    return
  fi
  find "${target}" -xdev -depth -mindepth 1 ! -type d -exec rm -f -- {} + || failed=1
  find "${target}" -xdev -depth -mindepth 1 -type d -exec rmdir -- {} + || failed=1
  rmdir -- "${target}" || failed=1
  return "${failed}"
}

ensure_no_nested_mounts() {
  local root="$1"
  if [[ ! -r /proc/self/mountinfo ]]; then
    echo "无法读取 /proc/self/mountinfo；为避免跨挂载点修改，部署已停止。"
    return 1
  fi
  "${NODE_BIN}" - "${root}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path').posix;
const root = fs.realpathSync(process.argv[2]);
const prefix = root.endsWith('/') ? root : root + '/';
const decodeMountPath = value => value.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(Number.parseInt(digits, 8)));
for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
  if (!line) continue;
  const fields = line.split(' ');
  if (fields.length < 6) continue;
  const mountPoint = path.normalize(decodeMountPath(fields[4]));
  if (mountPoint.startsWith(prefix)) {
    console.error('检测到应用目录内的嵌套挂载点：' + mountPoint);
    process.exit(2);
  }
}
NODE
}

rollback_release() {
  local failed=0
  local entry source target metadata data_name old_uid old_gid old_mode restore_unit
  local mounts_safe=true
  if [[ "${SERVICE_RESTART_ATTEMPTED}" == true ]]; then
    if ! systemctl stop "${SERVICE_NAME}"; then echo "回滚前无法停止新版本服务。"; failed=1; fi
  fi
  if [[ "${SOURCE_TRANSACTION_ACTIVE}" == true || "${MODULES_SWITCHED}" == true || -n "${MODULES_OLD}" ]]; then
    if ! ensure_no_nested_mounts "${APP_DIR}"; then mounts_safe=false; failed=1; fi
  fi
  if [[ "${mounts_safe}" == true && "${SOURCE_TRANSACTION_ACTIVE}" == true ]]; then
    if [[ "${SOURCE_OVERLAY_STARTED}" == true ]]; then
      for entry in "${PUBLISHED_TOP_LEVEL[@]}"; do
        target="${APP_DIR}/${entry}"
        if ! remove_path_no_cross "${target}"; then
          echo "回滚时无法安全移除本轮源码：${target}"
          failed=1
        fi
      done
    fi
    for entry in "${BACKED_UP_TOP_LEVEL[@]}"; do
      source="${SOURCE_BACKUP}/${entry}"
      target="${APP_DIR}/${entry}"
      if [[ -e "${source}" || -L "${source}" ]]; then
        if [[ -e "${target}" || -L "${target}" ]]; then
          echo "回滚目标仍被占用，旧源码保留在：${source}"
          failed=1
        elif ! mv -- "${source}" "${target}"; then
          echo "无法恢复旧源码：${target}"
          failed=1
        fi
      fi
    done
    if [[ -n "${SOURCE_BACKUP}" && -d "${SOURCE_BACKUP}" ]]; then rmdir -- "${SOURCE_BACKUP}" 2>/dev/null || true; fi
  fi
  if [[ "${mounts_safe}" == true ]]; then
    target="${APP_DIR}/node_modules"
    if [[ -n "${MODULES_OLD}" && ( -e "${MODULES_OLD}" || -L "${MODULES_OLD}" ) ]]; then
      if [[ -e "${target}" || -L "${target}" ]]; then
        if ! remove_path_no_cross "${target}"; then
          echo "回滚时无法安全移除本轮依赖：${target}"
          failed=1
        fi
      fi
      if [[ ! -e "${target}" && ! -L "${target}" ]]; then
        if ! mv -- "${MODULES_OLD}" "${target}"; then echo "无法恢复旧依赖目录。"; failed=1; fi
      fi
    elif [[ "${MODULES_SWITCHED}" == true && ( -e "${target}" || -L "${target}" ) ]]; then
      if ! remove_path_no_cross "${target}"; then echo "无法移除本轮新依赖目录。"; failed=1; fi
    fi
  fi
  if [[ "${INITIAL_SETTINGS_CREATED}" == true ]]; then
    target="${APP_DIR}/settings.json"
    if [[ -f "${target}" && ! -L "${target}" ]]; then
      if ! rm -f -- "${target}"; then echo "无法移除本轮创建的首次管理员凭据。"; failed=1; fi
    elif [[ -e "${target}" || -L "${target}" ]]; then
      echo "首次管理员凭据路径类型已变化，拒绝自动移除：${target}"
      failed=1
    fi
  fi
  for metadata in "${SENSITIVE_METADATA[@]}"; do
    IFS=: read -r data_name old_uid old_gid old_mode <<< "${metadata}"
    target="${APP_DIR}/${data_name}"
    if [[ -f "${target}" && ! -L "${target}" ]]; then
      if ! chown "${old_uid}:${old_gid}" -- "${target}" || ! chmod "${old_mode}" -- "${target}"; then
        echo "无法恢复敏感数据文件元数据：${target}"
        failed=1
      fi
    fi
  done
  if [[ -n "${APP_DIR_METADATA}" && -d "${APP_DIR}" && ! -L "${APP_DIR}" ]]; then
    IFS=: read -r old_uid old_gid old_mode <<< "${APP_DIR_METADATA}"
    if ! chown "${old_uid}:${old_gid}" -- "${APP_DIR}" || ! chmod "${old_mode}" -- "${APP_DIR}"; then
      echo "无法恢复应用目录元数据。"
      failed=1
    fi
  fi
  if [[ "${UNIT_WRITTEN}" == true ]]; then
    if [[ -n "${UNIT_BACKUP}" && -f "${UNIT_BACKUP}" ]]; then
      restore_unit="$(mktemp "${UNIT_FILE}.rollback.XXXXXX")"
      if ! cp -p -- "${UNIT_BACKUP}" "${restore_unit}" || ! mv -f -- "${restore_unit}" "${UNIT_FILE}"; then
        rm -f -- "${restore_unit}" 2>/dev/null || true
        echo "无法原子恢复旧 systemd 单元。"
        failed=1
      fi
    elif ! rm -f -- "${UNIT_FILE}"; then
      echo "无法移除本轮新建的 systemd 单元。"
      failed=1
    fi
    if ! systemctl daemon-reload; then echo "回滚后无法重新加载 systemd。"; failed=1; fi
    if [[ "${SERVICE_WAS_ENABLED}" == true ]]; then
      if ! systemctl enable "${SERVICE_NAME}" >/dev/null; then echo "无法恢复服务的启用状态。"; failed=1; fi
    elif ! systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1; then
      echo "警告：无法确认服务已恢复为非启用状态。"
    fi
  fi
  if [[ "${SERVICE_RESTART_ATTEMPTED}" == true ]]; then
    if [[ "${SERVICE_WAS_ACTIVE}" == true ]]; then
      if ! systemctl restart "${SERVICE_NAME}"; then echo "旧版本文件已恢复，但服务重新启动失败。"; failed=1; fi
    elif ! systemctl stop "${SERVICE_NAME}"; then
      echo "旧服务原本未运行，但无法确认回滚后仍为停止状态。"
      failed=1
    fi
  fi
  return "${failed}"
}
commit_release_transaction() {
  local backup
  SOURCE_TRANSACTION_ACTIVE=false
  SOURCE_OVERLAY_STARTED=false
  MODULES_SWITCHED=false
  UNIT_WRITTEN=false
  SERVICE_RESTART_ATTEMPTED=false
  INITIAL_SETTINGS_CREATED=false
  for backup in "${SOURCE_BACKUP}" "${MODULES_OLD}"; do
    [[ -n "${backup}" && ( -e "${backup}" || -L "${backup}" ) ]] || continue
    if ! remove_path_no_cross "${backup}"; then
      echo "警告：发布已成功，但旧版本备份无法安全清理：${backup}"
    fi
  done
  SOURCE_BACKUP=""
  MODULES_OLD=""
  if [[ -n "${UNIT_BACKUP}" ]]; then rm -f -- "${UNIT_BACKUP}" || true; fi
  UNIT_BACKUP=""
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  if (( exit_code == 0 )) && [[ "${SOURCE_TRANSACTION_ACTIVE}" == true || "${MODULES_SWITCHED}" == true ]]; then
    echo "发布事务未提交，正在恢复旧版本。"
    exit_code=1
  fi
  if (( exit_code != 0 )); then
    if ! rollback_release; then
      echo "自动回滚未完全完成；请检查保留的 .source.previous / .node_modules.previous 目录。"
    fi
  fi
  if [[ -n "${MODULES_NEXT}" && ( -e "${MODULES_NEXT}" || -L "${MODULES_NEXT}" ) ]]; then remove_path_no_cross "${MODULES_NEXT}" || true; fi
  if [[ -n "${UNIT_NEXT}" ]]; then rm -f -- "${UNIT_NEXT}" || true; fi
  if [[ -n "${TOP_LEVEL_MANIFEST}" ]]; then rm -f -- "${TOP_LEVEL_MANIFEST}" || true; fi
  if [[ -n "${UNIT_BACKUP}" ]]; then rm -f -- "${UNIT_BACKUP}" || true; fi
  if [[ -n "${STAGE_DIR}" && ( -e "${STAGE_DIR}" || -L "${STAGE_DIR}" ) ]]; then remove_path_no_cross "${STAGE_DIR}" || true; fi
  exit "${exit_code}"
}
trap cleanup EXIT

tar -C "${SOURCE_DIR}" --one-file-system \
  --exclude=.git --exclude=node_modules --exclude=runtime --exclude=release \
  --exclude='.runtime-*' --exclude='.deploy-*' \
  --exclude=settings.json --exclude=users.json --exclude=inbounds.json --exclude=relays.json \
  --exclude=agents.json --exclude=traffic.json --exclude=audit.json --exclude=runtime-xray.json --exclude=agent-xray-config.json --exclude=.3xui-lite-agent-state.json \
  -cf - . | tar -C "${STAGE_DIR}" -xf -

cd "${STAGE_DIR}"
npm ci --omit=dev --no-audit --no-fund --ignore-scripts
npm run check

install -d -o root -g root -m 0750 "${APP_DIR}"
if ! ensure_no_nested_mounts "${APP_DIR}"; then exit 1; fi

TOP_LEVEL_MANIFEST="$(mktemp)"
if ! "${NODE_BIN}" - "${STAGE_DIR}" "${TOP_LEVEL_MANIFEST}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const stage = process.argv[2];
const manifest = process.argv[3];
const protectedNames = new Set(['settings.json', 'users.json', 'inbounds.json', 'relays.json', 'agents.json', 'traffic.json', 'audit.json', 'runtime-xray.json', 'agent-xray-config.json', '.3xui-lite-agent-state.json', 'runtime', 'release', '.git']);
const names = fs.readdirSync(stage).sort();
if (names.some(name => protectedNames.has(name))) {
  console.error('暂存目录包含受保护的运行数据或部署目录，拒绝发布。');
  process.exit(2);
}
const published = names.filter(name => name !== 'node_modules');
if (!published.length) { console.error('暂存目录没有可发布的源码。'); process.exit(2); }
const chunks = [];
for (const name of published) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) process.exit(2);
  chunks.push(Buffer.from(name), Buffer.from([0]));
}
fs.writeFileSync(manifest, Buffer.concat(chunks), { mode: 0o600 });
NODE
then
  echo "无法生成安全的源码发布清单。"
  exit 1
fi
while IFS= read -r -d '' entry; do PUBLISHED_TOP_LEVEL+=("${entry}"); done < "${TOP_LEVEL_MANIFEST}"

# Keep the backup on the application filesystem so every move is an atomic
# rename. Avoid a rare name collision with a source entry.
while :; do
  SOURCE_BACKUP="$(mktemp -d "${APP_DIR}/.source.previous.XXXXXX")"
  backup_name="${SOURCE_BACKUP##*/}"
  backup_collision=false
  for entry in "${PUBLISHED_TOP_LEVEL[@]}"; do
    if [[ "${entry}" == "${backup_name}" ]]; then backup_collision=true; break; fi
  done
  if [[ "${backup_collision}" == false ]]; then break; fi
  rmdir -- "${SOURCE_BACKUP}"
done

SOURCE_TRANSACTION_ACTIVE=true
for entry in "${PUBLISHED_TOP_LEVEL[@]}"; do
  target="${APP_DIR}/${entry}"
  if [[ -e "${target}" || -L "${target}" ]]; then
    if ! mv -- "${target}" "${SOURCE_BACKUP}/${entry}"; then
      echo "无法备份现有源码条目：${target}"
      exit 1
    fi
    BACKED_UP_TOP_LEVEL+=("${entry}")
  fi
done

SOURCE_OVERLAY_STARTED=true
if ! tar -C "${STAGE_DIR}" --one-file-system --exclude=node_modules -cf - . | tar -C "${APP_DIR}" -xf -; then
  echo "源码展开失败，正在恢复上一版本。"
  exit 1
fi

MODULES_NEXT="$(mktemp -d "${APP_DIR}/.node_modules.next.XXXXXX")"
cp -a "${STAGE_DIR}/node_modules/." "${MODULES_NEXT}/"
if [[ -e "${APP_DIR}/node_modules" || -L "${APP_DIR}/node_modules" ]]; then
  MODULES_OLD="$(mktemp -d "${APP_DIR}/.node_modules.previous.XXXXXX")"
  rmdir "${MODULES_OLD}"
  if ! mv -- "${APP_DIR}/node_modules" "${MODULES_OLD}"; then
    echo "无法备份现有依赖目录。"
    exit 1
  fi
fi
if ! mv -- "${MODULES_NEXT}" "${APP_DIR}/node_modules"; then
  echo "依赖目录切换失败，正在恢复上一版本。"
  exit 1
fi
MODULES_NEXT=""
MODULES_SWITCHED=true
PUBLISH_PERMISSION_TARGETS=()
for entry in "${PUBLISHED_TOP_LEVEL[@]}"; do PUBLISH_PERMISSION_TARGETS+=("${APP_DIR}/${entry}"); done
PUBLISH_PERMISSION_TARGETS+=("${APP_DIR}/node_modules")
for target in "${PUBLISH_PERMISSION_TARGETS[@]}"; do
  if ! find "${target}" -xdev ! -type l -exec chown root:root {} +; then
    echo "无法归一化本轮发布文件所有权：${target}"
    exit 1
  fi
  if ! find "${target}" -xdev -type l -exec chown -h root:root {} +; then
    echo "无法安全归一化本轮发布符号链接所有权：${target}"
    exit 1
  fi
  if ! find "${target}" -xdev ! -type l -exec chmod go-w {} +; then
    echo "无法移除本轮发布文件的组/其他用户写权限：${target}"
    exit 1
  fi
done
chown root:root -- "${APP_DIR}"
chmod 0750 -- "${APP_DIR}"
for data_name in "${SENSITIVE_DATA_NAMES[@]}"; do
  data_path="${APP_DIR}/${data_name}"
  if [[ -f "${data_path}" && ! -L "${data_path}" ]]; then
    chown root:root -- "${data_path}"
    chmod 0600 -- "${data_path}"
  fi
done
for target in "${PUBLISH_PERMISSION_TARGETS[@]}"; do
  ownership_issue="$(find "${target}" -xdev \( ! -user root -o ! -group root \) -print -quit)"
  write_issue="$(find "${target}" -xdev ! -type l \( -perm -0020 -o -perm -0002 \) -print -quit)"
  if [[ -n "${ownership_issue}" ]]; then echo "部署所有权校验失败：${ownership_issue}"; exit 1; fi
  if [[ -n "${write_issue}" ]]; then echo "部署写权限校验失败：${write_issue}"; exit 1; fi
done
for data_name in "${SENSITIVE_DATA_NAMES[@]}"; do
  data_path="${APP_DIR}/${data_name}"
  if [[ -f "${data_path}" && ! -L "${data_path}" && "$(stat -c '%u:%g:%a' -- "${data_path}")" != "0:0:600" ]]; then
    echo "敏感数据权限校验失败：${data_path}"
    exit 1
  fi
done
if [[ -f "${UNIT_FILE}" ]]; then
  UNIT_BACKUP="$(mktemp)"
  cp -p -- "${UNIT_FILE}" "${UNIT_BACKUP}"
fi
UNIT_NEXT="$(mktemp "${UNIT_FILE}.next.XXXXXX")"
chmod 0600 -- "${UNIT_NEXT}"
cat > "${UNIT_NEXT}" <<UNIT
[Unit]
Description=3xUI Lite Agent 管理面板
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="${APP_DIR}"
Environment=NODE_ENV=production
Environment=PORT=${PORT_VALUE}
Environment=PANEL_HOST=${PANEL_HOST_VALUE}
Environment=SECURE_COOKIE=${SECURE_COOKIE_VALUE}
Environment=TRUST_PROXY=${TRUST_PROXY_VALUE}
ExecStart="${NODE_BIN}" "${APP_DIR}/server.js"
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
mv -f -- "${UNIT_NEXT}" "${UNIT_FILE}"
UNIT_NEXT=""
UNIT_WRITTEN=true

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
if [[ ! -e "${APP_DIR}/settings.json" && ! -L "${APP_DIR}/settings.json" ]]; then
  if ! INITIAL_ADMIN_PASSWORD="$("${NODE_BIN}" - "${APP_DIR}/settings.json" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = process.argv[2];
const password = crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(16).toString('base64url');
const hash = crypto.scryptSync(password, salt, 64).toString('base64');
const settings = { admin: { username: 'admin', salt, hash, mustChangePassword: true, defaultPassword: false, defaultPasswordChecked: true }, tls: { domain: '', email: '', certPath: '', keyPath: '', updatedAt: '' } };
const descriptor = fs.openSync(file, 'wx', 0o600);
try { fs.writeFileSync(descriptor, JSON.stringify(settings, null, 2)); fs.fsyncSync(descriptor); }
finally { fs.closeSync(descriptor); }
fs.chmodSync(file, 0o600);
process.stdout.write(password);
NODE
)"; then
    echo "无法安全创建首次管理员凭据；发布将自动恢复上一状态。"
    exit 1
  fi
  INITIAL_SETTINGS_CREATED=true
fi
SERVICE_RESTART_ATTEMPTED=true
systemctl restart "${SERVICE_NAME}"
systemctl is-active --quiet "${SERVICE_NAME}"
if ! "${NODE_BIN}" - "${PANEL_HOST_VALUE}" "${PORT_VALUE}" "${APP_DIR}/package.json" <<'NODE'
const http = require('node:http');
const fs = require('node:fs');
const bindAddress = process.argv[2];
const port = Number(process.argv[3]);
const expectedVersion = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).version;
const hostname = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress === '::' ? '::1' : bindAddress;
const deadline = Date.now() + 20000;
function probe() {
  return new Promise(resolve => {
    let settled = false; const finish = result => { if (settled) return; settled = true; resolve(result); };
    const request = http.get({ hostname, port, path: '/api/health', timeout: 1500 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 65536) response.destroy(new Error('响应过大')); else chunks.push(chunk); });
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(response.statusCode === 200 && payload.ok === true && payload.version === expectedVersion ? { ok: true } : { ok: false, error: `HTTP ${response.statusCode} 或版本不匹配` });
        } catch { finish({ ok: false, error: '健康检查响应不是有效 JSON' }); }
      });
      response.on('aborted', () => finish({ ok: false, error: '健康检查响应被中断' }));
      response.on('error', error => finish({ ok: false, error: error.message }));
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', error => finish({ ok: false, error: error.message }));
  });
}
(async () => {
  let lastError = '';
  while (Date.now() < deadline) {
    const result = await probe();
    if (result.ok) process.exit(0);
    lastError = result.error || lastError;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.error('面板健康检查失败：' + (lastError || '20 秒内未返回有效状态'));
  process.exit(1);
})().catch(error => { console.error('面板健康检查失败：' + error.message); process.exit(1); });
NODE
then
  echo "新版本面板未通过健康检查，正在恢复上一版本。"
  exit 1
fi
systemctl --no-pager --full status "${SERVICE_NAME}"
commit_release_transaction

if [[ -n "${INITIAL_ADMIN_PASSWORD}" ]]; then
  echo
  echo "已创建首次管理员账号：admin"
  printf '一次性初始密码：%s\n' "${INITIAL_ADMIN_PASSWORD}"
  echo "请立即保存并在首次登录后修改；该密码不会写入 systemd 单元或安装日志文件。"
fi

echo
echo "安装完成。面板监听：${PANEL_HOST_VALUE}:${PORT_VALUE}"
echo "生产环境请仅允许管理 IP 或反向代理访问面板端口，并优先通过 HTTPS 访问。"
echo "首次凭据仅在新安装时输出一次；升级不会覆盖现有管理员设置。"
