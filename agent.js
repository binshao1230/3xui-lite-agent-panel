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

const AGENT_VERSION = '0.4.1';
function option(name, fallback = '') { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? (process.argv[index + 1] || '') : (process.env[`AGENT_${name.toUpperCase()}`] || fallback); }
const controller = option('controller').replace(/\/$/, '');
const agentStartedAt = new Date().toISOString();
const id = option('id'); const token = option('token'); const once = process.argv.includes('--once');
if (!/^https?:\/\//.test(controller) || !id || !token) { console.error('Usage: node agent.js --controller https://panel.example.com --id agent-... --token ...'); process.exit(1); }
const relays = new Map();
const xrayRuntime = { child: null, signature: '', tasks: [], status: 'stopped', lastError: '', lastLog: '' };
const xrayConfigFile = path.join(path.dirname(__filename), 'agent-xray-config.json');
function xrayBinary() { const local = path.join(path.dirname(__filename), 'runtime', process.platform === 'win32' ? 'xray.exe' : 'xray'); return process.env.XRAY_BIN || (fs.existsSync(local) ? local : (process.platform === 'win32' ? 'xray.exe' : 'xray')); }
function xrayProbe() { const binary = xrayBinary(); const result = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); if (result.error || result.status !== 0) return { available: false, version: '', error: result.error?.code === 'ENOENT' ? 'Xray Core 未安装' : (result.stderr || result.error?.message || 'Xray Core 不可用').slice(0, 240) }; return { available: true, version: (result.stdout || result.stderr || '').split(/\r?\n/)[0].trim(), error: '' }; }
function appendXrayLog(value) { xrayRuntime.lastLog = `${xrayRuntime.lastLog}${String(value || '')}`.slice(-1200); }
function stopXray() { if (xrayRuntime.child && xrayRuntime.child.exitCode === null && !xrayRuntime.child.killed) try { xrayRuntime.child.kill(); } catch {} xrayRuntime.child = null; xrayRuntime.status = 'stopped'; }
function inboundStates() { return xrayRuntime.tasks.map(task => ({ id: task.id, status: xrayRuntime.status, lastError: xrayRuntime.lastError, updatedAt: new Date().toISOString() })); }
function verifyTcpListener(port) { return new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); }); socket.setTimeout(1500); socket.on('error', () => resolve(false)); socket.on('timeout', () => { socket.destroy(); resolve(false); }); }); }
async function syncInbounds(tasks) {
  const desired = (Array.isArray(tasks) ? tasks : []).filter(task => Number.isInteger(Number(task.id)) && task.xray).map(task => ({ ...task, id: Number(task.id) })); const signature = JSON.stringify(desired);
  if (!desired.length) { stopXray(); xrayRuntime.tasks = []; xrayRuntime.signature = signature; xrayRuntime.lastError = ''; return; }
  if (signature === xrayRuntime.signature && xrayRuntime.child && xrayRuntime.child.exitCode === null && !xrayRuntime.child.killed) return;
  stopXray(); xrayRuntime.tasks = desired; xrayRuntime.signature = signature; xrayRuntime.status = 'starting'; xrayRuntime.lastError = ''; const probe = xrayProbe();
  if (!probe.available) { xrayRuntime.status = 'error'; xrayRuntime.lastError = probe.error; return; }
  const inbounds = desired.map(task => { const inbound = JSON.parse(JSON.stringify(task.xray)); if (inbound.listen === '') delete inbound.listen; return inbound; }); const config = { log: { loglevel: 'warning' }, inbounds, outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'blocked' }] }; fs.writeFileSync(xrayConfigFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  const check = spawnSync(xrayBinary(), ['run', '-test', '-c', xrayConfigFile], { encoding: 'utf8', timeout: 10000, windowsHide: true }); if (check.error || check.status !== 0) { xrayRuntime.status = 'error'; xrayRuntime.lastError = (check.stderr || check.stdout || check.error?.message || 'Xray 配置校验失败').slice(0, 500); return; }
  const child = spawn(xrayBinary(), ['run', '-c', xrayConfigFile], { cwd: path.dirname(__filename), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); xrayRuntime.child = child; child.stdout.on('data', appendXrayLog); child.stderr.on('data', appendXrayLog); child.on('error', error => { xrayRuntime.status = 'error'; xrayRuntime.lastError = error.message; }); child.on('exit', (code, signal) => { if (code && code !== 0) { xrayRuntime.status = 'error'; xrayRuntime.lastError = `Xray exited (${code}${signal ? `/${signal}` : ''})`; } else if (xrayRuntime.status !== 'stopped') xrayRuntime.status = 'stopped'; xrayRuntime.child = null; }); await new Promise(resolve => setTimeout(resolve, 500)); const listening = await verifyTcpListener(desired[0].port); if (!listening || !xrayRuntime.child || xrayRuntime.child.exitCode !== null) { stopXray(); xrayRuntime.status = 'error'; xrayRuntime.lastError = xrayRuntime.lastError || `Xray 未在端口 ${desired[0].port} 建立监听`; return; } xrayRuntime.status = 'running'; console.log(`[agent] Xray started with ${desired.length} inbound(s)`);
}
const stateFile = path.join(path.dirname(__filename), '.3xui-lite-agent-state.json');
function readAgentState() { try { const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return state && typeof state === 'object' ? state : {}; } catch { return {}; } }
const agentState = readAgentState();
function saveAgentState() { try { fs.writeFileSync(stateFile, JSON.stringify(agentState), { mode: 0o600 }); } catch (error) { console.error(`[agent] unable to save local state: ${error.message}`); } }
function downloadText(urlText, redirects = 0) {
  if (redirects > 3) return Promise.reject(new Error('too many update redirects'));
  const url = new URL(urlText); const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => { const request = client.get(url, { timeout: 15000, headers: { 'User-Agent': '3xui-lite-agent' } }, response => { if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) return resolve(downloadText(new URL(response.headers.location, url).toString(), redirects + 1)); if (response.statusCode !== 200) return reject(new Error(`update download HTTP ${response.statusCode}`)); const chunks = []; let size = 0; response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) response.destroy(new Error('update payload too large')); else chunks.push(chunk); }); response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject); }); request.on('timeout', () => request.destroy(new Error('update download timeout'))); request.on('error', reject); });
}
function downloadBuffer(urlText, redirects = 0) {
  if (redirects > 3) return Promise.reject(new Error('too many download redirects'));
  const url = new URL(urlText); const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => { const request = client.get(url, { timeout: 60000, headers: { 'User-Agent': '3xui-lite-agent' } }, response => { if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) return resolve(downloadBuffer(new URL(response.headers.location, url).toString(), redirects + 1)); if (response.statusCode !== 200) return reject(new Error(`download HTTP ${response.statusCode}`)); const chunks = []; let size = 0; response.on('data', chunk => { size += chunk.length; if (size > 80 * 1024 * 1024) response.destroy(new Error('download payload too large')); else chunks.push(chunk); }); response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject); }); request.on('timeout', () => request.destroy(new Error('download timeout'))); request.on('error', reject); });
}
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
async function installXrayCore(request) {
  if (!request?.id || agentState.xrayInstallAck === request.id || agentState.xrayInstalling) return false;
  agentState.xrayInstalling = true; agentState.xrayInstallError = ''; saveAgentState();
  try {
    const assetName = xrayAssetName(); const release = JSON.parse(await downloadText('https://api.github.com/repos/XTLS/Xray-core/releases/latest')); const asset = release.assets?.find(item => item.name === assetName); const digest = release.assets?.find(item => item.name === `${assetName}.dgst`); if (!asset?.browser_download_url || !digest?.browser_download_url) throw new Error(`官方 release 缺少 ${assetName} 或校验文件`);
    const [archive, digestText] = await Promise.all([downloadBuffer(asset.browser_download_url), downloadText(digest.browser_download_url)]); const expected = (digestText.match(/[a-fA-F0-9]{64}/) || [])[0]; const actual = crypto.createHash('sha256').update(archive).digest('hex'); if (!expected || actual.toLowerCase() !== expected.toLowerCase()) throw new Error('Xray 下载 SHA-256 校验失败');
    ensureUnzip(); const runtimeDir = path.join(path.dirname(__filename), 'runtime'); const archiveFile = path.join(runtimeDir, `${assetName}.download`); fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(archiveFile, archive, { mode: 0o600 }); const extract = spawnSync('unzip', ['-oq', archiveFile, 'xray', '-d', runtimeDir], { encoding: 'utf8', timeout: 60000 }); try { fs.unlinkSync(archiveFile); } catch {} if (extract.error || extract.status !== 0) throw new Error(`解压 Xray 失败：${(extract.stderr || extract.error?.message || '').slice(0, 240)}`);
    const binary = path.join(runtimeDir, 'xray'); fs.chmodSync(binary, 0o755); const probe = xrayProbe(); if (!probe.available) throw new Error(probe.error); agentState.xrayInstallAck = request.id; agentState.xrayInstallError = ''; console.log(`[agent] Xray Core installed: ${probe.version}`); return true;
  } catch (error) { agentState.xrayInstallError = error.message || String(error); console.error(`[agent] Xray install failed: ${agentState.xrayInstallError}`); return false; }
  finally { agentState.xrayInstalling = false; saveAgentState(); }
}async function applyUpdate(update) {
  if (!update?.id || !update?.url || agentState.updateAck === update.id) return false;
  const nextFile = `${__filename}.next`; const content = await downloadText(update.url); fs.writeFileSync(nextFile, content, { mode: 0o700 }); const check = spawnSync(process.execPath, ['--check', nextFile], { encoding: 'utf8' });
  if (check.status !== 0) { try { fs.unlinkSync(nextFile); } catch {} throw new Error(`downloaded Agent failed syntax check: ${(check.stderr || '').trim()}`); }
  fs.renameSync(nextFile, __filename); agentState.updateAck = update.id; saveAgentState(); console.log('[agent] update installed; restarting service'); setTimeout(() => process.exit(75), 250); return true;
}
function postJson(urlText, payload) {
  const url = new URL(urlText); const data = Buffer.from(JSON.stringify(payload)); const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => { const req = client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 10000 }, res => { let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; }); res.on('end', () => { let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {} if (res.statusCode < 200 || res.statusCode >= 300) { const error = new Error(body.error || `HTTP ${res.statusCode}`); error.statusCode = res.statusCode; return reject(error); } resolve(body); }); }); req.on('timeout', () => req.destroy(new Error('request timeout'))); req.on('error', reject); req.end(data); });
}
function relayState(rule, runtime) { return { id: rule.id, status: runtime.status, lastError: runtime.lastError || '', bytesIn: runtime.bytesIn, bytesOut: runtime.bytesOut, connections: runtime.connections, updatedAt: new Date().toISOString() }; }
function relayStates() { return [...relays.values()].map(item => relayState(item.rule, item.runtime)); }
function stopRelay(relayId) { const item = relays.get(relayId); if (!item) return; for (const server of item.runtime.servers) try { server.close(); } catch {} for (const socket of item.runtime.udpClients.values()) try { socket.close(); } catch {} relays.delete(relayId); }
function createTcp(rule, runtime) {
  const server = net.createServer(client => { runtime.connections++; const upstream = net.connect({ host: rule.targetHost, port: rule.targetPort }); let closed = false; const close = () => { if (closed) return; closed = true; runtime.connections = Math.max(0, runtime.connections - 1); client.destroy(); upstream.destroy(); }; client.on('data', chunk => { runtime.bytesIn += chunk.length; }); upstream.on('data', chunk => { runtime.bytesOut += chunk.length; }); client.on('error', close); upstream.on('error', error => { runtime.lastError = error.message; close(); }); client.on('close', close); upstream.on('close', close); client.pipe(upstream); upstream.pipe(client); });
  runtime.servers.push(server); return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.listen(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
function createUdp(rule, runtime) {
  const server = dgram.createSocket('udp4'); runtime.servers.push(server); const clients = runtime.udpClients;
  server.on('message', (message, remote) => { runtime.bytesIn += message.length; const key = `${remote.address}:${remote.port}`; let upstream = clients.get(key); if (!upstream) { upstream = dgram.createSocket('udp4'); upstream.on('message', reply => { runtime.bytesOut += reply.length; server.send(reply, remote.port, remote.address); }); upstream.on('error', error => { runtime.lastError = error.message; }); clients.set(key, upstream); } upstream.send(message, rule.targetPort, rule.targetHost); });
  return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.bind(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
async function startRelay(rule) {
  const runtime = { status: 'starting', lastError: '', bytesIn: 0, bytesOut: 0, connections: 0, servers: [], udpClients: new Map() }; relays.set(rule.id, { rule, runtime, signature: JSON.stringify(rule) });
  try { if (rule.transport === 'tcp' || rule.transport === 'tcp+udp') await createTcp(rule, runtime); if (rule.transport === 'udp' || rule.transport === 'tcp+udp') await createUdp(rule, runtime); runtime.status = 'running'; console.log(`[agent] relay ${rule.name} is running on ${rule.bindAddress}:${rule.listenPort}`); }
  catch (error) { runtime.status = 'error'; runtime.lastError = error.message; for (const server of runtime.servers) try { server.close(); } catch {} for (const socket of runtime.udpClients.values()) try { socket.close(); } catch {} console.error(`[agent] relay ${rule.name} failed: ${error.message}`); }
}
async function syncRelays(tasks) {
  const wanted = new Map((Array.isArray(tasks) ? tasks : []).filter(rule => Number.isInteger(Number(rule.id)) && rule.targetHost && rule.listenPort && rule.targetPort).map(rule => [Number(rule.id), { ...rule, id: Number(rule.id) }]));
  for (const [relayId] of relays) if (!wanted.has(relayId)) stopRelay(relayId);
  for (const [relayId, rule] of wanted) { const existing = relays.get(relayId); const signature = JSON.stringify(rule); if (!existing || existing.signature !== signature || existing.runtime.status === 'error') { if (existing) stopRelay(relayId); await startRelay(rule); } }
}
async function heartbeat() {
  const probe = xrayProbe(); const response = await postJson(`${controller}/api/agent/heartbeat`, { id, token, info: { version: AGENT_VERSION, hostname: os.hostname(), platform: `${process.platform} ${os.release()}`, arch: process.arch, nodeVersion: process.version, uptimeSeconds: Math.floor(os.uptime()), memoryTotal: os.totalmem(), memoryFree: os.freemem(), cpus: os.cpus().length, addresses: Object.values(os.networkInterfaces()).flat().filter(item => item && !item.internal && item.address).map(item => item.address), processId: process.pid, agentStartedAt, updateAck: agentState.updateAck || '', xrayInstallAck: agentState.xrayInstallAck || '', xrayInstalling: agentState.xrayInstalling === true, xrayInstallError: agentState.xrayInstallError || '', xrayAvailable: probe.available, xrayVersion: probe.version, inboundStates: inboundStates(), relayStates: relayStates() } });
  await syncRelays(response.relays); await syncInbounds(response.inbounds); if (response.xrayInstall) await installXrayCore(response.xrayInstall); else if (agentState.xrayInstallAck) { agentState.xrayInstallAck = ''; saveAgentState(); } if (response.update) await applyUpdate(response.update); else if (agentState.updateAck) { agentState.updateAck = ''; saveAgentState(); } console.log(`[agent] heartbeat accepted; ${response.relays?.length || 0} relay / ${response.inbounds?.length || 0} inbound task(s)`); return Number(response.intervalSeconds || 15) * 1000;
}(async () => { const handleFailure = error => { if (error.statusCode === 401 || error.statusCode === 403) { for (const relayId of [...relays.keys()]) stopRelay(relayId); console.error(`[agent] authorization was revoked; all relays stopped: ${error.message}`); return; } console.error(`[agent] heartbeat failed: ${error.message}`); }; try { const interval = await heartbeat(); if (once) { await heartbeat(); return; } setInterval(() => heartbeat().catch(handleFailure), interval); } catch (error) { handleFailure(error); if (once) process.exitCode = 1; else setInterval(() => heartbeat().catch(handleFailure), 15000); } })();