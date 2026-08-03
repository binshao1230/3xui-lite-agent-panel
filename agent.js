'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const net = require('node:net');
const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');

const AGENT_VERSION = '0.5.7';
function option(name, fallback = '') { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? (process.argv[index + 1] || '') : (process.env[`AGENT_${name.toUpperCase()}`] || fallback); }
const controller = option('controller').replace(/\/$/, '');
function controllerEndpointAllowed(value) {
  try {
    const url = new URL(value); const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.split('.')[0] === '127');
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch { return false; }
}
const agentStartedAt = new Date().toISOString();
const id = option('id'); const token = option('token'); const once = process.argv.includes('--once');
if (!controllerEndpointAllowed(controller) || !id || !token) { console.error('Agent 控制面板必须使用 HTTPS 根地址；仅 localhost、127.0.0.0/8 或 [::1] 可使用 HTTP'); process.exit(1); }
const relays = new Map();
const xrayRuntime = { child: null, signature: '', tasks: [], rejectedTasks: [], status: 'stopped', lastError: '', lastLog: '' };
const xrayConfigFile = path.join(path.dirname(__filename), 'agent-xray-config.json');
function xrayBinary() { const local = path.join(path.dirname(__filename), 'runtime', process.platform === 'win32' ? 'xray.exe' : 'xray'); return process.env.XRAY_BIN || (fs.existsSync(local) ? local : (process.platform === 'win32' ? 'xray.exe' : 'xray')); }
function xrayProbe() { const binary = xrayBinary(); const result = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); if (result.error || result.status !== 0) return { available: false, version: '', error: result.error?.code === 'ENOENT' ? 'Xray Core 未安装' : (result.stderr || result.error?.message || 'Xray Core 不可用').slice(0, 240) }; return { available: true, version: (result.stdout || result.stderr || '').split(/\r?\n/)[0].trim(), error: '' }; }
function appendXrayLog(value) { xrayRuntime.lastLog = `${xrayRuntime.lastLog}${String(value || '')}`.slice(-1200); }
function waitForXrayExit(child, timeout = 3000) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false; const finish = exited => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('close', onExit); resolve(exited); }; const onExit = () => finish(true); const timer = setTimeout(() => finish(false), timeout); child.once('exit', onExit); child.once('close', onExit);
  });
}
async function stopXray() {
  const child = xrayRuntime.child;
  if (!child || child.exitCode !== null) { if (xrayRuntime.child === child) xrayRuntime.child = null; xrayRuntime.status = 'stopped'; return true; }
  try { if (!child.killed && !child.kill()) throw new Error('Xray stop signal was rejected'); }
  catch (error) { xrayRuntime.status = 'error'; xrayRuntime.lastError = error.message || 'Xray stop failed'; return false; }
  let exited = await waitForXrayExit(child);
  if (!exited) { try { child.kill('SIGKILL'); } catch {} exited = await waitForXrayExit(child, 1000); }
  if (!exited) { xrayRuntime.status = 'error'; xrayRuntime.lastError = 'Xray did not exit after forced stop'; return false; }
  if (xrayRuntime.child === child) xrayRuntime.child = null;
  xrayRuntime.status = 'stopped';
  return true;
}
function inboundStates() {
  const states = new Map(xrayRuntime.tasks.map(task => [task.id, { id: task.id, revision: String(task.revision || ''), status: xrayRuntime.status, lastError: xrayRuntime.lastError, updatedAt: new Date().toISOString() }]));
  for (const task of xrayRuntime.rejectedTasks) states.set(task.id, { id: task.id, revision: String(task.revision || ''), status: 'error', lastError: xrayRuntime.lastError || '新配置未应用', updatedAt: new Date().toISOString() });
  return [...states.values()];
}
function verifyTcpListener(port) { return new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); let done = false; const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); }; socket.setTimeout(1500); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false)); }); }
async function syncInbounds(tasks) {
  const desired = (Array.isArray(tasks) ? tasks : []).filter(task => Number.isInteger(Number(task.id)) && task.xray).map(task => ({ ...task, id: Number(task.id) })); const signature = JSON.stringify(desired);
  if (!desired.length) { if (!await stopXray()) return; xrayRuntime.tasks = []; xrayRuntime.rejectedTasks = []; xrayRuntime.signature = signature; xrayRuntime.lastError = ''; return; }
  if (signature === xrayRuntime.signature && xrayRuntime.child && xrayRuntime.child.exitCode === null && !xrayRuntime.child.killed) { xrayRuntime.rejectedTasks = []; return; }
  const probe = xrayProbe(); const currentRunning = Boolean(xrayRuntime.child && xrayRuntime.child.exitCode === null && !xrayRuntime.child.killed);
  if (!probe.available) { xrayRuntime.status = currentRunning ? 'running' : 'error'; xrayRuntime.rejectedTasks = desired; xrayRuntime.lastError = `新配置未应用：${probe.error}`; return; }
  const inbounds = desired.map(task => { const inbound = JSON.parse(JSON.stringify(task.xray)); if (inbound.listen === '') delete inbound.listen; return inbound; }); const config = { log: { loglevel: 'warning' }, inbounds, outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'blocked' }] }; const nextConfigFile = `${xrayConfigFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(nextConfigFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    const check = spawnSync(xrayBinary(), ['run', '-test', '-c', nextConfigFile], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (check.error || check.status !== 0) { xrayRuntime.status = currentRunning ? 'running' : 'error'; xrayRuntime.rejectedTasks = desired; xrayRuntime.lastError = `新配置未应用：${(check.stderr || check.stdout || check.error?.message || 'Xray 配置校验失败').slice(0, 500)}`; return; }
    fs.renameSync(nextConfigFile, xrayConfigFile);
  } catch (error) { xrayRuntime.status = currentRunning ? 'running' : 'error'; xrayRuntime.rejectedTasks = desired; xrayRuntime.lastError = `新配置未应用：${error.message || '配置文件写入失败'}`; return; }
  finally { try { if (fs.existsSync(nextConfigFile)) fs.unlinkSync(nextConfigFile); } catch {} }
  if (!await stopXray()) { xrayRuntime.rejectedTasks = desired; return; }
  xrayRuntime.tasks = desired; xrayRuntime.rejectedTasks = []; xrayRuntime.signature = signature; xrayRuntime.status = 'starting'; xrayRuntime.lastError = '';
  const child = spawn(xrayBinary(), ['run', '-c', xrayConfigFile], { cwd: path.dirname(__filename), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); xrayRuntime.child = child; child.stdout.on('data', appendXrayLog); child.stderr.on('data', appendXrayLog); child.on('error', error => { if (xrayRuntime.child === child) { xrayRuntime.status = 'error'; xrayRuntime.lastError = error.message; } }); child.on('exit', (code, signal) => { if (xrayRuntime.child !== child) return; if (code && code !== 0) { xrayRuntime.status = 'error'; xrayRuntime.lastError = `Xray exited (${code}${signal ? `/${signal}` : ''})`; } else if (xrayRuntime.status !== 'stopped') xrayRuntime.status = 'stopped'; xrayRuntime.child = null; });
  await new Promise(resolve => setTimeout(resolve, 500)); const checks = await Promise.all(desired.map(task => verifyTcpListener(task.port))); const missing = desired.filter((task, index) => !checks[index]).map(task => task.port);
  if (missing.length || !xrayRuntime.child || xrayRuntime.child.exitCode !== null) { await stopXray(); xrayRuntime.status = 'error'; xrayRuntime.lastError = xrayRuntime.lastError || `Xray 未在端口 ${missing.join(', ') || desired[0].port} 建立监听`; return; }
  xrayRuntime.status = 'running'; console.log(`[agent] Xray started with ${desired.length} inbound(s)`);
}
const stateFile = path.join(path.dirname(__filename), '.3xui-lite-agent-state.json');
function readAgentState() {
  try { const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state root must be an object'); return state; }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw new Error(`Agent state file is invalid; repair ${stateFile} before restarting: ${error.message}`); }
}
const agentState = readAgentState();
let recoveredInterruptedJob = false;
if (agentState.xrayInstalling === true) {
  agentState.xrayInstalling = false;
  if (agentState.xrayInstallAttemptId) agentState.xrayInstallFailedId = agentState.xrayInstallAttemptId;
  agentState.xrayInstallAttemptId = '';
  agentState.xrayInstallError = '检测到上次 Xray 安装被中断；请由管理员重新下发任务';
  recoveredInterruptedJob = true;
}
if (agentState.updateInProgressId) {
  agentState.updateFailedId = agentState.updateInProgressId;
  agentState.updateInProgressId = '';
  agentState.updateError = '检测到上次 Agent 更新被中断；请由管理员重新下发任务';
  recoveredInterruptedJob = true;
}
if (recoveredInterruptedJob) saveAgentState();
function saveAgentState() {
  const nextFile = `${stateFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(nextFile, JSON.stringify(agentState), { mode: 0o600 }); fs.chmodSync(nextFile, 0o600); fs.renameSync(nextFile, stateFile); return true; }
  catch (error) { try { if (fs.existsSync(nextFile)) fs.unlinkSync(nextFile); } catch {} console.error(`[agent] unable to save local state: ${error.message}`); return false; }
}
function networkTargetAllowed(url) {
  const host = url.hostname.replaceAll('[', '').replaceAll(']', '').toLowerCase(); const loopback = host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.split('.')[0] === '127');
  return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
}
function downloadPayload(urlText, limit, label, redirects = 0, timeout = 60000) {
  if (redirects > 3) return Promise.reject(new Error('too many ' + label + ' redirects'));
  let url; try { url = new URL(urlText); } catch { return Promise.reject(new Error(label + ' URL is invalid')); }
  if (!networkTargetAllowed(url)) return Promise.reject(new Error(label + ' URL must use HTTPS (loopback HTTP only)'));
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false; const finish = (error, value) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value); };
    const request = client.get(url, { timeout, headers: { 'User-Agent': '3xui-lite-agent' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirected = new URL(response.headers.location, url).toString(); response.resume(); return finish(null, downloadPayload(redirected, limit, label, redirects + 1, timeout));
      }
      if (response.statusCode !== 200) { response.resume(); return finish(new Error(label + ' HTTP ' + response.statusCode)); }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > limit) { const error = new Error(label + ' payload too large'); response.destroy(error); request.destroy(error); finish(error); } else chunks.push(chunk); });
      response.on('end', () => finish(null, Buffer.concat(chunks)));
      response.on('aborted', () => finish(new Error(label + ' response aborted')));
      response.on('error', error => finish(error));
    });
    request.on('timeout', () => { const error = new Error(label + ' timeout'); request.destroy(error); finish(error); });
    request.on('error', error => finish(error));
  });
}
async function downloadText(urlText, redirects = 0) { return (await downloadPayload(urlText, 2 * 1024 * 1024, 'download', redirects, 15000)).toString('utf8'); }
function downloadBuffer(urlText, redirects = 0) { return downloadPayload(urlText, 80 * 1024 * 1024, 'download', redirects, 60000); }
function xrayAssetName() {
  if (process.platform !== 'linux') throw new Error('自动安装目前支持 Linux Agent');
  if (process.arch === 'x64') return 'Xray-linux-64.zip'; if (process.arch === 'arm64') return 'Xray-linux-arm64-v8a.zip'; if (process.arch === 'arm') return 'Xray-linux-arm32-v7a.zip'; throw new Error(`不支持的 CPU 架构：${process.arch}`);
}
function commandAvailable(command) { const result = spawnSync(command, ['-v'], { stdio: 'ignore', timeout: 5000 }); return !result.error && result.status === 0; }
function ensureUnzip() {
  if (commandAvailable('unzip')) return;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('自动安装 Xray 需要 root 权限（请使用 systemd 部署命令）');
  const managers = [['apt-get', [['update'], ['install', '-y', 'unzip']]], ['dnf', [['install', '-y', 'unzip']]], ['yum', [['install', '-y', 'unzip']]], ['apk', [['add', '--no-cache', 'unzip']]]];
  for (const [manager, calls] of managers) { if (!commandAvailable(manager)) continue; for (const args of calls) { const result = spawnSync(manager, args, { encoding: 'utf8', timeout: 180000 }); if (result.error || result.status !== 0) throw new Error(`${manager} 安装 unzip 失败：${(result.stderr || result.error?.message || '').slice(0, 240)}`); } if (commandAvailable('unzip')) return; }
  throw new Error('未找到可用包管理器，无法安装 unzip');
}
function publishAgentXrayFiles(sourceDir, runtimeDir) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const releaseId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const names = ['xray', 'geoip.dat', 'geosite.dat'].filter((name, index) => index === 0 || fs.existsSync(path.join(sourceDir, name)));
  const entries = names.map(name => {
    const source = path.join(sourceDir, name); if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`安装包中未找到 ${name}`);
    const extension = path.extname(name); const stem = extension ? name.slice(0, -extension.length) : name;
    return { name, source, destination: path.join(runtimeDir, name), next: path.join(runtimeDir, `.${stem}.${releaseId}.next${extension}`), backup: path.join(runtimeDir, `.${stem}.${releaseId}.previous${extension}`), backedUp: false, published: false };
  });
  let version = '';
  try {
    for (const entry of entries) { fs.copyFileSync(entry.source, entry.next); if (entry.name === 'xray') fs.chmodSync(entry.next, 0o755); }
    const stagedBinary = entries.find(entry => entry.name === 'xray').next; const verify = spawnSync(stagedBinary, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (verify.error || verify.status !== 0) throw new Error(`Xray 发布前校验失败：${(verify.stderr || verify.error?.message || '').slice(0, 240)}`);
    version = (verify.stdout || verify.stderr || '').split(/\r?\n/)[0].trim();
    for (const entry of entries) { if (fs.existsSync(entry.destination)) { fs.renameSync(entry.destination, entry.backup); entry.backedUp = true; } fs.renameSync(entry.next, entry.destination); entry.published = true; }
  } catch (error) {
    let rollbackError = '';
    for (const entry of [...entries].reverse()) {
      try { if (entry.published && fs.existsSync(entry.destination)) fs.unlinkSync(entry.destination); if (entry.backedUp && fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.destination); }
      catch (rollback) { rollbackError ||= rollback.message || String(rollback); }
    }
    for (const entry of entries) try { if (fs.existsSync(entry.next)) fs.unlinkSync(entry.next); } catch {}
    if (rollbackError) throw new Error(`${error.message || error}；回滚失败：${rollbackError}`);
    throw error;
  }
  for (const entry of entries) { try { if (fs.existsSync(entry.backup)) fs.unlinkSync(entry.backup); } catch {} try { if (fs.existsSync(entry.next)) fs.unlinkSync(entry.next); } catch {} }
  return version;
}
async function installXrayCore(request) {
  if (!request?.id || agentState.xrayInstallAck === request.id || agentState.xrayInstallFailedId === request.id || agentState.xrayInstalling) return false;
  agentState.xrayInstalling = true; agentState.xrayInstallAttemptId = request.id; agentState.xrayInstallFailedId = ''; agentState.xrayInstallError = '';
  if (!saveAgentState()) {
    agentState.xrayInstalling = false; agentState.xrayInstallAttemptId = ''; agentState.xrayInstallFailedId = request.id; agentState.xrayInstallError = '无法持久化 Xray 安装任务状态，已拒绝执行以避免重复下载';
    return false;
  }
  let installed = false;
  try {
    const assetName = xrayAssetName(); const release = JSON.parse(await downloadText('https://api.github.com/repos/XTLS/Xray-core/releases/latest')); const asset = release.assets?.find(item => item.name === assetName); const digest = release.assets?.find(item => item.name === `${assetName}.dgst`); if (!asset?.browser_download_url || !digest?.browser_download_url) throw new Error(`官方 release 缺少 ${assetName} 或校验文件`);
    const [archive, digestText] = await Promise.all([downloadBuffer(asset.browser_download_url), downloadText(digest.browser_download_url)]); const expected = (digestText.match(/[a-fA-F0-9]{64}/) || [])[0]; const actual = crypto.createHash('sha256').update(archive).digest('hex'); if (!expected || actual.toLowerCase() !== expected.toLowerCase()) throw new Error('Xray 下载 SHA-256 校验失败');
    ensureUnzip(); const baseDir = path.dirname(__filename); const runtimeDir = path.join(baseDir, 'runtime'); const temp = fs.mkdtempSync(path.join(baseDir, '.xray-install-')); let installedVersion = '';
    try {
      const archiveFile = path.join(temp, `${assetName}.download`); const out = path.join(temp, 'out'); fs.writeFileSync(archiveFile, archive, { mode: 0o600 }); fs.mkdirSync(out);
      const extract = spawnSync('unzip', ['-oq', archiveFile, '-d', out], { encoding: 'utf8', timeout: 60000 });
      if (extract.error || extract.status !== 0) throw new Error(`解压 Xray 失败：${(extract.stderr || extract.error?.message || '').slice(0, 240)}`);
      const binary = path.join(out, 'xray'); if (!fs.existsSync(binary)) throw new Error('安装包中未找到 xray'); fs.chmodSync(binary, 0o755);
      installedVersion = publishAgentXrayFiles(out, runtimeDir);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    agentState.xrayInstallAck = request.id; agentState.xrayInstallFailedId = ''; agentState.xrayInstallError = ''; installed = true; console.log(`[agent] Xray Core installed: ${installedVersion}`);
  } catch (error) {
    agentState.xrayInstallAck = ''; agentState.xrayInstallFailedId = request.id; agentState.xrayInstallError = error.message || String(error); console.error(`[agent] Xray install failed: ${agentState.xrayInstallError}`);
  } finally {
    agentState.xrayInstalling = false; agentState.xrayInstallAttemptId = '';
    if (!saveAgentState() && installed) {
      agentState.xrayInstallAck = ''; agentState.xrayInstallFailedId = request.id; agentState.xrayInstallError = 'Xray 已安装，但结果无法持久化；已停止自动处理以避免重复下载'; installed = false;
    }
  }
  return installed;
}
async function applyUpdate(update) {
  if (!update?.id || !update?.url || agentState.updateAck === update.id || agentState.updateFailedId === update.id || agentState.updateInProgressId === update.id) return false;
  agentState.updateInProgressId = update.id; agentState.updateFailedId = ''; agentState.updateError = '';
  if (!saveAgentState()) {
    agentState.updateInProgressId = ''; agentState.updateFailedId = update.id; agentState.updateError = '无法持久化 Agent 更新任务状态，已拒绝执行以避免重复下载';
    return false;
  }
  const nextFile = path.join(path.dirname(__filename), `.${path.basename(__filename)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.next.js`);
  try {
    const content = await downloadText(update.url); fs.writeFileSync(nextFile, content, { mode: 0o600 }); const check = spawnSync(process.execPath, ['--check', nextFile], { encoding: 'utf8' });
    if (check.error || check.status !== 0) throw new Error(`downloaded Agent failed syntax check: ${(check.stderr || check.error?.message || '').trim()}`);
    fs.chmodSync(nextFile, 0o700); fs.renameSync(nextFile, __filename); agentState.updateAck = update.id; agentState.updateInProgressId = '';
    if (!saveAgentState()) throw new Error('Agent update installed, but its acknowledgement could not be persisted; automatic restart was deferred to avoid an update loop');
    console.log('[agent] update installed; restarting service'); setTimeout(() => process.exit(75), 250); return true;
  } catch (error) {
    if (agentState.updateAck === update.id) agentState.updateAck = '';
    agentState.updateInProgressId = ''; agentState.updateFailedId = update.id; agentState.updateError = error.message || String(error); saveAgentState();
    console.error(`[agent] update failed: ${agentState.updateError}`); return false;
  } finally { try { if (fs.existsSync(nextFile)) fs.unlinkSync(nextFile); } catch {} }
}
function postJson(urlText, payload) {
  let url; try { url = new URL(urlText); } catch { return Promise.reject(new Error('controller URL is invalid')); }
  if (!networkTargetAllowed(url)) return Promise.reject(new Error('controller URL must use HTTPS (loopback HTTP only)'));
  const data = Buffer.from(JSON.stringify(payload)); const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false; const finish = (error, value) => { if (settled) return; settled = true; if (error) reject(error); else resolve(value); };
    const request = client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 10000 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { const error = new Error('controller response too large'); response.destroy(error); request.destroy(error); finish(error); } else chunks.push(chunk); });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); let responseBody = {};
        try { responseBody = raw ? JSON.parse(raw) : {}; } catch {}
        if (response.statusCode < 200 || response.statusCode >= 300) { const error = new Error(responseBody.error || ('HTTP ' + response.statusCode)); error.statusCode = response.statusCode; return finish(error); }
        finish(null, responseBody);
      });
      response.on('aborted', () => finish(new Error('controller response aborted')));
      response.on('error', error => finish(error));
    });
    request.on('timeout', () => { const error = new Error('request timeout'); request.destroy(error); finish(error); });
    request.on('error', error => finish(error));
    request.end(data);
  });
}
const relayControlAcks = new Map();
function relayState(rule, runtime) { return { id: rule.id, revision: String(rule.revision || ''), status: runtime.status, lastError: runtime.lastError || '', bytesIn: runtime.bytesIn, bytesOut: runtime.bytesOut, connections: runtime.connections, updatedAt: new Date().toISOString() }; }
function relayStates() { return [...relays.values()].map(item => relayState(item.rule, item.runtime)).concat([...relayControlAcks.values()]); }
function createTcp(rule, runtime) {
  const server = net.createServer(client => { runtime.connections++; const upstream = net.connect({ host: rule.targetHost, port: rule.targetPort }); let closed = false; runtime.sockets.add(client); runtime.sockets.add(upstream); const close = () => { if (closed) return; closed = true; runtime.connections = Math.max(0, runtime.connections - 1); runtime.sockets.delete(client); runtime.sockets.delete(upstream); client.destroy(); upstream.destroy(); }; client.on('data', chunk => { runtime.bytesIn += chunk.length; }); upstream.on('data', chunk => { runtime.bytesOut += chunk.length; }); client.on('error', close); upstream.on('error', error => { runtime.lastError = error.message; close(); }); client.on('close', close); upstream.on('close', close); client.pipe(upstream); upstream.pipe(client); });
  runtime.servers.push(server); return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.listen(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
function closeUdpClients(clients, runtime) {
  const count = clients.size;
  for (const entry of clients.values()) { if (entry?.timer) clearTimeout(entry.timer); try { (entry?.socket || entry).close(); } catch {} }
  clients.clear();
  if (runtime) runtime.connections = Math.max(0, runtime.connections - count);
}
function createUdp(rule, runtime) {
  const server = dgram.createSocket('udp4'); runtime.servers.push(server); const clients = runtime.udpClients; const idleMs = 2 * 60 * 1000;
  server.on('message', (message, remote) => {
    runtime.bytesIn += message.length; const key = `${remote.address}:${remote.port}`; let entry = clients.get(key);
    if (!entry) {
      const socket = dgram.createSocket('udp4'); entry = { socket, timer: null, connected: false, pending: [] };
      const closeEntry = () => { if (entry.timer) clearTimeout(entry.timer); if (clients.get(key) === entry) { clients.delete(key); runtime.connections = Math.max(0, runtime.connections - 1); } try { socket.close(); } catch {} };
      const refresh = () => { if (entry.timer) clearTimeout(entry.timer); entry.timer = setTimeout(closeEntry, idleMs); entry.timer.unref?.(); };
      const send = packet => { if (clients.get(key) !== entry) return; socket.send(packet, error => { if (error) { runtime.lastError = error.message; closeEntry(); } }); };
      entry.refresh = refresh; entry.send = send; socket.on('message', reply => { runtime.bytesOut += reply.length; server.send(reply, remote.port, remote.address, error => { if (error) runtime.lastError = error.message; }); refresh(); }); socket.on('error', error => { runtime.lastError = error.message; closeEntry(); }); clients.set(key, entry); runtime.connections++;
      try { socket.connect(rule.targetPort, rule.targetHost, () => { if (clients.get(key) !== entry) return; entry.connected = true; const pending = entry.pending.splice(0); for (const packet of pending) send(packet); refresh(); }); }
      catch (error) { runtime.lastError = error.message; closeEntry(); return; }
    }
    entry.refresh();
    if (entry.connected) entry.send(message);
    else if (entry.pending.length < 32) entry.pending.push(Buffer.from(message));
    else runtime.lastError = `UDP session ${key} queued too many packets while connecting to target`;
  });
  return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.bind(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
function closeRelayServer(server) { return new Promise(resolve => { try { server.close(resolve); } catch { resolve(); } }); }
async function closeRelayRuntime(runtime) {
  for (const socket of runtime.sockets) try { socket.destroy(); } catch {}
  runtime.sockets.clear(); closeUdpClients(runtime.udpClients, runtime);
  const servers = runtime.servers.splice(0); await Promise.allSettled(servers.map(closeRelayServer)); runtime.connections = 0;
}
async function stopRelay(relayId) { const item = relays.get(relayId); if (!item) return; item.runtime.status = 'stopping'; await closeRelayRuntime(item.runtime); if (relays.get(relayId) === item) relays.delete(relayId); }
async function startRelay(rule) {
  const runtime = { status: 'starting', lastError: '', bytesIn: 0, bytesOut: 0, connections: 0, servers: [], sockets: new Set(), udpClients: new Map() }; relays.set(rule.id, { rule, runtime, signature: JSON.stringify(rule) });
  try { if (rule.transport === 'tcp' || rule.transport === 'tcp+udp') await createTcp(rule, runtime); if (rule.transport === 'udp' || rule.transport === 'tcp+udp') await createUdp(rule, runtime); runtime.status = 'running'; console.log(`[agent] relay ${rule.name} is running on ${rule.bindAddress}:${rule.listenPort}`); }
  catch (error) { await closeRelayRuntime(runtime); runtime.status = 'error'; runtime.lastError = error.message; console.error(`[agent] relay ${rule.name} failed: ${error.message}`); }
}
async function syncRelays(tasks) {
  const received = Array.isArray(tasks) ? tasks : [];
  const controls = new Map(received.filter(rule => Number.isInteger(Number(rule?.id)) && rule?.tombstone === true && ['stop', 'delete'].includes(rule.action) && rule.revision).map(rule => [Number(rule.id), { id: Number(rule.id), revision: String(rule.revision), action: rule.action }]));
  const wanted = new Map(received.filter(rule => Number.isInteger(Number(rule.id)) && rule.tombstone !== true && rule.targetHost && rule.listenPort && rule.targetPort).map(rule => [Number(rule.id), { ...rule, id: Number(rule.id) }]));
  for (const [relayId] of relays) if (!wanted.has(relayId)) await stopRelay(relayId);
  for (const [relayId, control] of controls) relayControlAcks.set(relayId, { id: relayId, revision: control.revision, status: 'stopped', lastError: '', bytesIn: 0, bytesOut: 0, connections: 0, updatedAt: new Date().toISOString() });
  for (const relayId of [...relayControlAcks.keys()]) if (!controls.has(relayId)) relayControlAcks.delete(relayId);
  for (const [relayId, rule] of wanted) { relayControlAcks.delete(relayId); const existing = relays.get(relayId); const signature = JSON.stringify(rule); if (!existing || existing.signature !== signature || existing.runtime.status === 'error') { if (existing) await stopRelay(relayId); await startRelay(rule); } }
}
async function heartbeat() {
  const probe = xrayProbe(); const response = await postJson(`${controller}/api/agent/heartbeat`, { id, token, info: { version: AGENT_VERSION, hostname: os.hostname(), platform: `${process.platform} ${os.release()}`, arch: process.arch, nodeVersion: process.version, uptimeSeconds: Math.floor(os.uptime()), memoryTotal: os.totalmem(), memoryFree: os.freemem(), cpus: os.cpus().length, addresses: Object.values(os.networkInterfaces()).flat().filter(item => item && !item.internal && item.address).map(item => item.address), processId: process.pid, agentStartedAt, updateAck: agentState.updateAck || '', updateFailedId: agentState.updateFailedId || '', updateError: agentState.updateError || '', xrayInstallAck: agentState.xrayInstallAck || '', xrayInstallFailedId: agentState.xrayInstallFailedId || '', xrayInstalling: agentState.xrayInstalling === true, xrayInstallError: agentState.xrayInstallError || '', xrayAvailable: probe.available, xrayVersion: probe.version, inboundStates: inboundStates(), relayStates: relayStates() } });
  await syncRelays(response.relays); await syncInbounds(response.inbounds);
  if (response.xrayInstall) {
    const installed = await installXrayCore(response.xrayInstall); if (installed) { xrayRuntime.signature = ''; await syncInbounds(response.inbounds); }
  } else if (agentState.xrayInstallAck || agentState.xrayInstallFailedId) {
    agentState.xrayInstallAck = ''; agentState.xrayInstallFailedId = ''; agentState.xrayInstallAttemptId = ''; agentState.xrayInstalling = false; agentState.xrayInstallError = ''; saveAgentState();
  }
  if (response.update) await applyUpdate(response.update);
  else if (agentState.updateAck || agentState.updateFailedId) {
    agentState.updateAck = ''; agentState.updateFailedId = ''; agentState.updateInProgressId = ''; agentState.updateError = ''; saveAgentState();
  }
  console.log(`[agent] heartbeat accepted; ${response.relays?.length || 0} relay / ${response.inbounds?.length || 0} inbound task(s)`); return Number(response.intervalSeconds || 15) * 1000;
}
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true; console.log(`[agent] received ${signal}, stopping relay and Xray processes`);
  await Promise.all([...relays.keys()].map(stopRelay));
  await stopXray(); process.exit(0);
}
process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.once('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
(async () => {
  const handleFailure = async error => { if (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 426) { await Promise.all([...relays.keys()].map(stopRelay)); await stopXray(); console.error(`[agent] authorization was revoked; all relays and Xray stopped: ${error.message}`); return; } console.error(`[agent] heartbeat failed: ${error.message}`); };
  const run = async () => {
    let interval = 15000;
    try { interval = await heartbeat(); }
    catch (error) { await handleFailure(error); if (once) process.exitCode = 1; }
    if (!once && !shuttingDown) setTimeout(run, interval);
  };
  await run();
})();
