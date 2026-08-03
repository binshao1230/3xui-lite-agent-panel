'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawnSync, spawn } = require('node:child_process');
const QRCode = require('qrcode');

const root = __dirname;
const relayFile = path.join(root, 'relays.json');
const inboundFile = path.join(root, 'inbounds.json');
const userFile = path.join(root, 'users.json');
const trafficFile = path.join(root, 'traffic.json');
const agentFile = path.join(root, 'agents.json');
const runtimeFile = path.join(root, 'runtime-xray.json');
const settingFile = path.join(root, 'settings.json');
const auditFile = path.join(root, 'audit.json');
const port = Number(process.env.PORT || 3000);
const PANEL_VERSION = '0.8.0';
const sessions = new Map();
const loginAttempts = new Map();
let generatedInitialAdminPassword = '';
const runtime = { child: null, startedAt: '', lastError: '', lastLog: '', installing: false };
let runtimeOperationTail = Promise.resolve();
let runtimeInstallQueued = false;
const networkState = { publicAddress: '', source: '', checkedAt: '', error: '', checking: false };
const relayRuntimes = new Map();
const publicFiles = new Set(['index.html', 'style.css', 'app.js', 'agent.js']);

const seedRelays = [];
const protocolMap = { 'VLESS + Reality': 'vless-reality', VLESS: 'vless', 'VLESS + TLS': 'vless-tls', 'VLESS + WebSocket': 'vless-ws', 'VLESS + gRPC': 'vless-grpc', 'Trojan + TLS': 'trojan-tls', Shadowsocks: 'shadowsocks' };
const protocolLabels = Object.fromEntries(Object.entries(protocolMap).map(([label, value]) => [value, label]));
const templateNames = { 'vless-reality': 'VLESS Reality 模板', vless: '纯 VLESS TCP 模板', 'vless-tls': 'VLESS TLS 模板', 'vless-ws': 'VLESS WebSocket + TLS 模板', 'vless-grpc': 'VLESS gRPC + TLS 模板', 'trojan-tls': 'Trojan TLS 模板', shadowsocks: 'Shadowsocks 2022 模板' };
const protocols = new Set(Object.keys(protocolMap));
const statuses = new Set(['running', 'stopped']);
const ss2022Methods = new Set(['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" };
const seedUsers = [];

function token(bytes = 16) { return crypto.randomBytes(bytes).toString('base64url'); }
let lastGeneratedId = 0;
function id() { const now = Date.now() * 1000; lastGeneratedId = Math.max(now, lastGeneratedId + 1); return lastGeneratedId; }
function passwordHash(password, salt = token(16)) { return { salt, hash: crypto.scryptSync(password, salt, 64).toString('base64') }; }
function validAdminPasswordRecord(admin) {
  if (!admin || typeof admin !== 'object' || !validText(admin.username, 64) || typeof admin.salt !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(admin.salt) || typeof admin.hash !== 'string') return false;
  try { const decoded = Buffer.from(admin.hash, 'base64'); return decoded.length === 64 && decoded.toString('base64') === admin.hash; } catch { return false; }
}
function usesDefaultPassword(admin) {
  if (!admin?.salt || !admin?.hash) return true;
  const expected = passwordHash('admin', admin.salt).hash;
  return expected.length === admin.hash.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(admin.hash));
}
function defaultSettings() {
  const configured = process.env.INITIAL_ADMIN_PASSWORD;
  if (configured !== undefined && (configured.length < 10 || configured.length > 128)) throw new Error('INITIAL_ADMIN_PASSWORD 必须为 10–128 个字符');
  const password = configured || token(24); generatedInitialAdminPassword = password;
  return { admin: { username: 'admin', ...passwordHash(password), mustChangePassword: true, defaultPassword: false, defaultPasswordChecked: true }, tls: { domain: '', email: '', certPath: '', keyPath: '', updatedAt: '' } };
}
function announceInitialAdminPassword() {
  if (!generatedInitialAdminPassword) return;
  console.log(`[security] 首次管理员账号：admin`);
  console.log(`[security] 一次性初始密码：${generatedInitialAdminPassword}`);
  console.log('[security] 此密码仅显示一次；登录后必须立即修改。');
  generatedInitialAdminPassword = '';
}
function dataFileError(file, error, expected = '有效 JSON') {
  const problem = new Error(`${path.basename(file)} 无法读取或不是${expected}；已保留原文件，请修复后重试`);
  problem.code = 'DATA_FILE_INVALID'; problem.cause = error; return problem;
}
function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingFile, 'utf8'));
    if (validAdminPasswordRecord(data?.admin)) {
      const admin = { username: 'admin', ...data.admin };
      if (admin.defaultPasswordChecked !== true) { admin.defaultPassword = usesDefaultPassword(admin); admin.defaultPasswordChecked = true; admin.mustChangePassword = Boolean(admin.mustChangePassword || admin.defaultPassword); writeSettings({ ...data, admin }); }
      admin.defaultPassword = Boolean(admin.defaultPassword); admin.mustChangePassword = Boolean(admin.mustChangePassword || admin.defaultPassword);
      return { admin, tls: { domain: '', email: '', certPath: '', keyPath: '', updatedAt: '', ...data.tls } };
    }
    throw dataFileError(settingFile, new Error('管理员配置字段缺失'), '有效的设置 JSON');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error?.code === 'DATA_FILE_INVALID' ? error : dataFileError(settingFile, error, '有效的设置 JSON');
  }
  const settings = defaultSettings();
  writeSettings(settings);
  return settings;
}
function writePrivateFile(file, contents) {
  const temp = `${file}.${process.pid}.${token(6)}.tmp`;
  try { fs.writeFileSync(temp, contents, { mode: 0o600 }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600); }
  finally { try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {} }
}
function writeSettings(settings) { writePrivateFile(settingFile, JSON.stringify(settings, null, 2)); }
function readStore(file, fallback, normalizer) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw dataFileError(file, new Error('顶层值不是数组'), '有效的 JSON 数组');
    return normalizer ? data.map(normalizer) : data;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback.map(item => ({ ...item }));
    throw error?.code === 'DATA_FILE_INVALID' ? error : dataFileError(file, error, '有效的 JSON 数组');
  }
}
function writeStore(file, items) { writePrivateFile(file, JSON.stringify(items, null, 2)); }
function readAudit(limit = 120) {
  try {
    const entries = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
    if (!Array.isArray(entries)) throw dataFileError(auditFile, new Error('顶层值不是数组'), '有效的 JSON 数组');
    return entries.slice(0, Math.max(1, Math.min(Number(limit) || 120, 1000)));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error?.code === 'DATA_FILE_INVALID' ? error : dataFileError(auditFile, error, '有效的 JSON 数组');
  }
}
function auditEvent(event) {
  try { const entries = readAudit(1000); entries.unshift({ id: id(), at: new Date().toISOString(), ...event }); writeStore(auditFile, entries.slice(0, 1000)); } catch (error) { console.error('Audit write failed:', error.message || error); }
}
function clientAddress(req) {
  const forwarded = process.env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : ''; return forwarded || req.socket.remoteAddress || 'unknown';
}
function pruneLoginAttempts(now) {
  if (loginAttempts.size <= 5000) return;
  for (const [key, attempt] of loginAttempts) if (now - attempt.startedAt > 15 * 60 * 1000 && attempt.until <= now) loginAttempts.delete(key);
  while (loginAttempts.size > 5000) loginAttempts.delete(loginAttempts.keys().next().value);
}
function createBackup() {
  const data = { settings: readSettings(), relays: readStore(relayFile, seedRelays, normalizeRelay), inbounds: readStore(inboundFile, seedInbounds, normalizeInbound), users: readStore(userFile, seedUsers), agents: readAgents(), traffic: readStore(trafficFile, []), audit: readAudit(1000) };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return { format: '3xui-lite-backup', schemaVersion: 1, panelVersion: PANEL_VERSION, exportedAt: new Date().toISOString(), checksum: 'sha256:' + checksum, containsSecrets: true, data };
}

function alignInboundWith3xui(inbound) {
  if (!inbound || typeof inbound !== 'object') return false;
  let changed = false; const settings = inbound.settings || {}; const stream = inbound.streamSettings || {}; const sniffing = inbound.sniffing || {};
  if (inbound.protocolCode === 'vless' && !Array.isArray(settings.fallbacks)) { settings.fallbacks = []; changed = true; }
  if (stream.network === 'tcp' && !stream.tcpSettings) { stream.tcpSettings = { header: { type: 'none' } }; changed = true; }
  if (stream.security === 'reality' && stream.realitySettings) {
    const reality = stream.realitySettings;
    if (reality.minClientVer === undefined) { reality.minClientVer = ''; changed = true; }
    if (reality.maxClientVer === undefined) { reality.maxClientVer = ''; changed = true; }
    if (reality.maxTimeDiff === undefined) { reality.maxTimeDiff = 0; changed = true; }
    if (!reality.settings) { reality.settings = {}; changed = true; }
    if (reality.settings.spiderX === undefined) { reality.settings.spiderX = '/'; changed = true; }
  }
  if (sniffing.routeOnly === undefined) { sniffing.routeOnly = false; changed = true; }
  if (changed) { inbound.settings = settings; inbound.streamSettings = stream; inbound.sniffing = sniffing; inbound.xray = { ...(inbound.xray || {}), settings, streamSettings: stream, sniffing }; }
  return changed;
}
function migrateInboundCompatibility() {
  try { const items = JSON.parse(fs.readFileSync(inboundFile, 'utf8')); if (!Array.isArray(items)) throw dataFileError(inboundFile, new Error('顶层值不是数组'), '有效的 JSON 数组'); if (items.some(alignInboundWith3xui)) writeStore(inboundFile, items); }
  catch (error) { if (error?.code !== 'ENOENT') throw error?.code === 'DATA_FILE_INVALID' ? error : dataFileError(inboundFile, error, '有效的 JSON 数组'); }
}
migrateInboundCompatibility();
function json(res, code, payload, headers = {}) {
  res.writeHead(code, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(code === 204 ? '' : JSON.stringify(payload));
}
function requestError(message, statusCode) { const error = new Error(message); error.statusCode = statusCode; return error; }
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0; let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { fail(requestError('请求内容过大', 413)); req.resume(); return; }
      if (!settled) raw += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw requestError('请求 JSON 必须是对象', 400);
        settled = true; resolve(parsed);
      } catch (error) { fail(error?.statusCode ? error : requestError('请求 JSON 格式无效', 400)); }
    });
    req.on('error', error => fail(error));
  });
}
function validText(value, max = 128) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function cleanText(value, fallback = '', max = 128) { return validText(value, max) ? value.trim() : fallback; }
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('='); const name = index < 0 ? item : item.slice(0, index); const encoded = index < 0 ? '' : item.slice(index + 1);
    try { return [name, decodeURIComponent(encoded)]; } catch { return [name, '']; }
  }));
}function currentSession(req) {
  const value = parseCookies(req).session;
  const session = value && sessions.get(value);
  if (!session || session.expiresAt < Date.now()) { if (value) sessions.delete(value); return null; }
  return { token: value, ...session };
}
function requestIsSecure(req) {
  if (req.socket?.encrypted) return true;
  if (process.env.TRUST_PROXY !== 'true') return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',').some(value => value.trim().toLowerCase() === 'https');
}
function requestOriginAllowed(req) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return true;
  const origin = cleanText(req.headers.origin, '', 512); if (!origin) return true;
  const expectedHost = cleanText(process.env.TRUST_PROXY === 'true' ? (req.headers['x-forwarded-host'] || req.headers.host) : req.headers.host, '', 255);
  try { const parsed = new URL(origin); const protocol = requestIsSecure(req) ? 'https:' : 'http:'; return parsed.protocol === protocol && parsed.host === expectedHost; } catch { return false; }
}
function sessionCookie(req, value, seconds = 0) {
  const secure = process.env.SECURE_COOKIE === 'true' || requestIsSecure(req) ? '; Secure' : '';
  return `session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
}
function requireAuth(req, res) {
  const session = currentSession(req); if (session) return session;
  json(res, 401, { error: '请先登录管理员账号' });
  return null;
}
function auditOnFinish(req, res, session, action = 'admin.request', resource = '') {
  if (!session) return;
  res.once('finish', () => auditEvent({ actor: session.username, action, resource: resource || new URL(req.url, 'http://localhost').pathname, method: req.method, outcome: res.statusCode < 400 ? 'success' : 'denied', status: res.statusCode, ip: clientAddress(req), userAgent: cleanText(req.headers['user-agent'], '', 180) }));
}
function shortId() { return crypto.randomBytes(8).toString('hex'); }
function x25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('base64url'), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('base64url') };
}
function shareName(name) { return encodeURIComponent(name).replace(/%20/g, '+'); }
function activeTlsSettings() {
  const tls = readSettings().tls;
  if (!tls.certPath || !tls.keyPath) return null;
  return { certificateFile: tls.certPath, keyFile: tls.keyPath };
}
function makeVlessReality(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const keys = x25519Pair(); const sid = shortId();
  const sni = cleanText(input.sni, 'www.microsoft.com'); const dest = cleanText(input.dest, `${sni}:443`);
  const fingerprint = cleanText(input.fingerprint, 'chrome'); const flow = typeof input.flow === 'string' ? cleanText(input.flow, '', 128) : 'xtls-rprx-vision'; const email = cleanText(input.email, `client-${nodeId}`);
  const settings = { clients: [{ id: clientId, email, flow }], decryption: 'none', fallbacks: [] };
  const streamSettings = { network: 'tcp', security: 'reality', tcpSettings: { header: { type: 'none' } }, realitySettings: { show: false, dest, xver: 0, serverNames: [sni], privateKey: keys.privateKey, minClientVer: '', maxClientVer: '', maxTimeDiff: 0, shortIds: [sid], settings: { publicKey: keys.publicKey, fingerprint, serverName: '', spiderX: '/' } } };
  const shareLink = `vless://${clientId}@${input.serverAddress}:${input.port}?type=tcp&encryption=none&security=reality&pbk=${keys.publicKey}&fp=${fingerprint}&sni=${encodeURIComponent(sni)}&sid=${sid}&spx=%2F&flow=${flow}#${shareName(input.name)}`;
  return finishInbound(input, nodeId, status, 'vless', 'Reality', settings, streamSettings, shareLink);
}
function makeVless(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const email = cleanText(input.email, `client-${nodeId}`);
  const settings = { clients: [{ id: clientId, email }], decryption: 'none', fallbacks: [] };
  const streamSettings = { network: 'tcp', security: 'none', tcpSettings: { header: { type: 'none' } } };
  const shareLink = `vless://${clientId}@${input.serverAddress}:${input.port}?type=tcp&encryption=none&security=none#${shareName(input.name)}`;
  return finishInbound(input, nodeId, status, 'vless', 'None', settings, streamSettings, shareLink);
}
function configuredTlsCertificate(input = {}) {
  const certPath = cleanText(input.certPath, '', 512); const keyPath = cleanText(input.keyPath, '', 512);
  if (certPath || keyPath) return certPath && keyPath ? { certificateFile: certPath, keyFile: keyPath } : null;
  return input.agentId ? null : activeTlsSettings();
}
function inboundTlsError(inbound) {
  if (inbound?.streamSettings?.security !== 'tls') return '';
  const certificate = inbound.streamSettings.tlsSettings?.certificates?.[0];
  if (!certificate?.certificateFile || !certificate?.keyFile) return 'TLS 节点缺少证书和私钥路径；请先在系统设置配置本机证书，或为远程 Agent 填写该机器上的证书路径';
  if (!inbound.agentId && (!fs.existsSync(certificate.certificateFile) || !fs.existsSync(certificate.keyFile))) return 'TLS 证书或私钥文件在本机不存在；请检查系统设置中的证书路径';
  return '';
}
function vlessTlsSettings(sni, input = {}) { const tlsSettings = { serverName: sni, minVersion: '1.2' }; const certificate = configuredTlsCertificate(input); if (certificate) tlsSettings.certificates = [certificate]; return tlsSettings; }
function makeVlessTls(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const email = cleanText(input.email, `client-${nodeId}`); const sni = cleanText(input.sni, input.serverAddress);
  const settings = { clients: [{ id: clientId, email }], decryption: 'none', fallbacks: [] }; const streamSettings = { network: 'tcp', security: 'tls', tcpSettings: { header: { type: 'none' } }, tlsSettings: vlessTlsSettings(sni, input) };
  return finishInbound(input, nodeId, status, 'vless', 'TLS', settings, streamSettings, `vless://${clientId}@${input.serverAddress}:${input.port}?type=tcp&encryption=none&security=tls&sni=${encodeURIComponent(sni)}#${shareName(input.name)}`);
}
function makeVlessWs(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const email = cleanText(input.email, `client-${nodeId}`); const sni = cleanText(input.sni, input.serverAddress); const wsPath = cleanText(input.path, '/vless', 180); const host = cleanText(input.host, sni, 180);
  const settings = { clients: [{ id: clientId, email }], decryption: 'none', fallbacks: [] }; const streamSettings = { network: 'ws', security: 'tls', tlsSettings: vlessTlsSettings(sni, input), wsSettings: { path: wsPath, headers: { Host: host } } };
  return finishInbound(input, nodeId, status, 'vless', 'WebSocket + TLS', settings, streamSettings, `vless://${clientId}@${input.serverAddress}:${input.port}?type=ws&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&host=${encodeURIComponent(host)}&path=${encodeURIComponent(wsPath)}#${shareName(input.name)}`);
}
function makeVlessGrpc(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const email = cleanText(input.email, `client-${nodeId}`); const sni = cleanText(input.sni, input.serverAddress); const serviceName = cleanText(input.serviceName, 'vless-grpc', 120);
  const settings = { clients: [{ id: clientId, email }], decryption: 'none', fallbacks: [] }; const streamSettings = { network: 'grpc', security: 'tls', tlsSettings: vlessTlsSettings(sni, input), grpcSettings: { serviceName, multiMode: false } };
  return finishInbound(input, nodeId, status, 'vless', 'gRPC + TLS', settings, streamSettings, `vless://${clientId}@${input.serverAddress}:${input.port}?type=grpc&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&serviceName=${encodeURIComponent(serviceName)}&mode=gun#${shareName(input.name)}`);
}function makeTrojanTls(input, nodeId, status) {
  const password = token(18); const sni = cleanText(input.sni, input.serverAddress); const email = cleanText(input.email, `client-${nodeId}`);
  const tlsSettings = { serverName: sni, minVersion: '1.2' }; const certificate = configuredTlsCertificate(input);
  if (certificate) tlsSettings.certificates = [certificate];
  const settings = { clients: [{ password, email }], fallbacks: [] };
  const streamSettings = { network: 'tcp', security: 'tls', tcpSettings: { header: { type: 'none' } }, tlsSettings };
  const shareLink = `trojan://${password}@${input.serverAddress}:${input.port}?security=tls&type=tcp&sni=${encodeURIComponent(sni)}#${shareName(input.name)}`;
  return finishInbound(input, nodeId, status, 'trojan', 'TLS', settings, streamSettings, shareLink);
}
function ss2022KeyBytes(method) { return method === '2022-blake3-aes-128-gcm' ? 16 : 32; }
function ss2022Key(method) { return crypto.randomBytes(ss2022KeyBytes(method)).toString('base64'); }
function makeShadowsocks(input, nodeId, status) {
  const requestedMethod = cleanText(input.method, '2022-blake3-aes-128-gcm'); const method = ss2022Methods.has(requestedMethod) ? requestedMethod : '2022-blake3-aes-128-gcm';
  const serverPassword = ss2022Key(method); const userPassword = ss2022Key(method); const email = cleanText(input.email, `client-${nodeId}`);
  const settings = { method, password: serverPassword, network: 'tcp,udp', clients: [{ password: userPassword, email, level: 0 }] };
  const streamSettings = { network: 'tcp', security: 'none', tcpSettings: { header: { type: 'none' } } }; const credentials = Buffer.from(`${method}:${serverPassword}:${userPassword}`).toString('base64url');
  return finishInbound(input, nodeId, status, 'shadowsocks', 'SS2022', settings, streamSettings, `ss://${credentials}@${input.serverAddress}:${input.port}#${shareName(input.name)}`);
}
function finishInbound(input, nodeId, status, protocolCode, security, settings, streamSettings, shareLink) {
  const sniffing = { enabled: true, destOverride: ['http', 'tls'], routeOnly: false };
  const xray = { listen: '', port: input.port, protocol: protocolCode, settings, streamSettings, tag: `inbound-${input.port}`, sniffing };
  return { id: nodeId, name: input.name, protocol: protocolLabels[input.protocolKey], protocolCode, template: input.templateName || templateNames[input.protocolKey], port: input.port, serverAddress: input.serverAddress, security, remark: input.remark, agentId: cleanText(input.agentId, '', 80), status, settings, streamSettings, sniffing, xray, shareLink };
}
function buildNode(data, forcedId = id(), forcedStatus = 'running') {
  const listenPort = Number(data.port); const protocolKey = protocolMap[data.protocol] || 'vless-reality'; const protocolLabel = protocolLabels[protocolKey];
  if (!validText(data.name) || !validText(data.serverAddress) || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) return null;
  const input = { ...data, id: forcedId, agentId: cleanText(data.agentId, '', 80), name: data.name.trim(), protocolKey, protocol: protocolLabel, port: listenPort, serverAddress: data.serverAddress.trim(), certPath: cleanText(data.certPath, '', 512), keyPath: cleanText(data.keyPath, '', 512), remark: cleanText(data.remark, '', 180), sni: cleanText(data.sni, '', 180), dest: cleanText(data.dest, '', 180), fingerprint: cleanText(data.fingerprint, 'chrome'), flow: typeof data.flow === 'string' ? cleanText(data.flow, '', 128) : 'xtls-rprx-vision', path: cleanText(data.path, '/vless', 180), host: cleanText(data.host, '', 180), serviceName: cleanText(data.serviceName, 'vless-grpc', 120), method: cleanText(data.method, '2022-blake3-aes-128-gcm'), email: cleanText(data.email, '', 100), templateName: templateNames[protocolKey] };
  if (protocolKey === 'vless') return makeVless(input, forcedId, forcedStatus);
  if (protocolKey === 'vless-tls') return makeVlessTls(input, forcedId, forcedStatus);
  if (protocolKey === 'vless-ws') return makeVlessWs(input, forcedId, forcedStatus);
  if (protocolKey === 'vless-grpc') return makeVlessGrpc(input, forcedId, forcedStatus);
  if (protocolKey === 'trojan-tls') return makeTrojanTls(input, forcedId, forcedStatus);
  if (protocolKey === 'shadowsocks') return makeShadowsocks(input, forcedId, forcedStatus);
  return makeVlessReality(input, forcedId, forcedStatus);
}
function vlessTransportShareLink(clientId, address, port, name, stream) {
  const network = stream.network || 'tcp'; const security = stream.security === 'tls' ? 'tls' : 'none'; const sni = stream.tlsSettings?.serverName || address; const tlsQuery = security === 'tls' ? `&sni=${encodeURIComponent(sni)}` : '';
  if (network === 'ws') { const ws = stream.wsSettings || {}; return `vless://${clientId}@${address}:${port}?type=ws&encryption=none&security=${security}${tlsQuery}&host=${encodeURIComponent(ws.headers?.Host || sni)}&path=${encodeURIComponent(ws.path || '/vless')}#${shareName(name)}`; }
  if (network === 'grpc') { const serviceName = stream.grpcSettings?.serviceName || 'vless-grpc'; return `vless://${clientId}@${address}:${port}?type=grpc&encryption=none&security=${security}${tlsQuery}&serviceName=${encodeURIComponent(serviceName)}&mode=gun#${shareName(name)}`; }
  return `vless://${clientId}@${address}:${port}?type=tcp&encryption=none&security=${security}${tlsQuery}#${shareName(name)}`;
}
function shareLinkForInbound(inbound) {
  const settings = inbound.settings || {}; const stream = inbound.streamSettings || {}; const client = settings.clients?.[0] || {}; const address = inbound.serverAddress; const port = inbound.port;
  if (inbound.protocolCode === 'vless') {
    if (inbound.security === 'Reality') { const reality = stream.realitySettings || {}; const config = reality.settings || {}; const sni = reality.serverNames?.[0] || ''; const sid = reality.shortIds?.[0] || ''; const flow = client.flow ?? 'xtls-rprx-vision'; return `vless://${client.id}@${address}:${port}?type=tcp&encryption=none&security=reality&pbk=${config.publicKey || ''}&fp=${config.fingerprint || 'chrome'}&sni=${encodeURIComponent(sni)}&sid=${sid}&spx=%2F&flow=${flow}#${shareName(inbound.name)}`; }
    return vlessTransportShareLink(client.id, address, port, inbound.name, stream);
  }
  if (inbound.protocolCode === 'trojan') { const tls = stream.security === 'tls'; const sniQuery = tls ? `&sni=${encodeURIComponent(stream.tlsSettings?.serverName || address)}` : ''; return `trojan://${client.password}@${address}:${port}?security=${tls ? 'tls' : 'none'}&type=tcp${sniQuery}#${shareName(inbound.name)}`; }
  if (inbound.protocolCode === 'shadowsocks') { const credentials = Buffer.from(`${settings.method}:${settings.password}:${client.password}`).toString('base64url'); return `ss://${credentials}@${address}:${port}#${shareName(inbound.name)}`; }
  return inbound.shareLink || '';
}
function objectFrom3xui(value, field) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error(`${field} 不是有效的 JSON 对象`); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是 JSON 对象`);
  return value;
}
function import3xuiInbound(data) {
  const source = objectFrom3xui(data.config || data.inbound || data, '3x-ui 入站配置');
  const protocolCode = cleanText(source.protocol, '').toLowerCase();
  if (!['vless', 'trojan', 'shadowsocks'].includes(protocolCode)) throw new Error('目前仅支持导入 VLESS、Trojan 和 Shadowsocks 入站');
  const listenPort = Number(source.port); const serverAddress = cleanText(data.serverAddress, '', 255);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('导入配置中的端口无效');
  if (!serverAddress) throw new Error('请填写客户端连接此节点时使用的服务器地址');
  const settings = objectFrom3xui(source.settings || {}, 'settings');
  const streamSettings = objectFrom3xui(source.streamSettings || { network: 'tcp', security: 'none' }, 'streamSettings');
  const sniffing = source.sniffing === undefined ? { enabled: true, destOverride: ['http', 'tls'], routeOnly: false } : objectFrom3xui(source.sniffing, 'sniffing');
  const network = cleanText(streamSettings.network, 'tcp').toLowerCase(); const transportSecurity = cleanText(streamSettings.security, 'none').toLowerCase();
  let protocolKey = protocolCode; let protocol = ''; let security = 'None';
  if (protocolCode === 'vless') {
    if (!Array.isArray(settings.clients) || !settings.clients[0]?.id) throw new Error('VLESS 配置缺少至少一个客户端 UUID');
    if (transportSecurity === 'reality') { protocolKey = 'vless-reality'; protocol = 'VLESS + Reality'; security = 'Reality'; }
    else if (network === 'ws') { protocolKey = 'vless-ws'; protocol = 'VLESS + WebSocket'; security = transportSecurity === 'tls' ? 'TLS' : 'None'; }
    else if (network === 'grpc') { protocolKey = 'vless-grpc'; protocol = 'VLESS + gRPC'; security = transportSecurity === 'tls' ? 'TLS' : 'None'; }
    else if (transportSecurity === 'tls') { protocolKey = 'vless-tls'; protocol = 'VLESS + TLS'; security = 'TLS'; }
    else { protocolKey = 'vless'; protocol = 'VLESS'; }
  } else if (protocolCode === 'trojan') {
    if (!Array.isArray(settings.clients) || !settings.clients[0]?.password) throw new Error('Trojan 配置缺少至少一个客户端密码');
    protocolKey = 'trojan-tls'; protocol = transportSecurity === 'tls' ? 'Trojan + TLS' : 'Trojan'; security = transportSecurity === 'tls' ? 'TLS' : 'None';
  } else {
    if (!settings.method || !settings.password) throw new Error('Shadowsocks 配置缺少 method 或 password');
    protocolKey = 'shadowsocks'; protocol = 'Shadowsocks'; security = 'SS2022';
  }
  const inbound = {
    id: id(), name: cleanText(data.name || source.remark || source.tag, `${protocol} ${listenPort}`, 120), protocol, protocolCode, template: '3x-ui 兼容导入', port: listenPort, serverAddress,
    security, remark: cleanText(data.remark || source.remark, '', 180), agentId: cleanText(data.agentId, '', 80), status: source.enable === false ? 'stopped' : 'running', settings, streamSettings, sniffing,
    xray: { listen: typeof source.listen === 'string' ? source.listen : '', port: listenPort, protocol: protocolCode, settings, streamSettings, tag: cleanText(source.tag, `inbound-${listenPort}`, 120), sniffing }
  };
  alignInboundWith3xui(inbound); inbound.template = `3x-ui ${protocol} 兼容配置`; inbound.shareLink = shareLinkForInbound(inbound);
  if (!inbound.shareLink) throw new Error('导入配置无法生成客户端链接，请确认客户端字段完整');
  return inbound;
}function importedInboundUpdate(existing, data) {
  const name = data.name === undefined ? existing.name : cleanText(data.name, '', 120); const serverAddress = data.serverAddress === undefined ? existing.serverAddress : cleanText(data.serverAddress, '', 255); const port = data.port === undefined ? Number(existing.port) : Number(data.port);
  if (!validText(name, 120) || !validText(serverAddress, 255) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const candidate = JSON.parse(JSON.stringify(existing)); candidate.name = name; candidate.serverAddress = serverAddress; candidate.port = port;
  if (data.agentId !== undefined) candidate.agentId = cleanText(data.agentId, '', 80);
  if (data.remark !== undefined) candidate.remark = cleanText(data.remark, '', 180);
  if (candidate.xray && typeof candidate.xray === 'object') candidate.xray.port = port;
  candidate.shareLink = shareLinkForInbound(candidate);
  return candidate.shareLink ? candidate : null;
}function updateInbound(existing, data) {
  if (data.protocol && data.protocol !== existing.protocol) throw new Error('编辑节点时不能切换协议；请新建节点。');
  if (/^3x-ui(?:\s|$)/i.test(String(existing.template || ''))) return importedInboundUpdate(existing, data);
  const currentStream = existing.streamSettings || {}, currentReality = currentStream.realitySettings || {}, currentTls = currentStream.tlsSettings || {}, currentCertificate = currentTls.certificates?.[0] || {}, currentClient = existing.settings?.clients?.[0] || {};
  const merged = { name: existing.name, port: existing.port, serverAddress: existing.serverAddress, agentId: existing.agentId || '', remark: existing.remark || '', sni: currentReality.serverNames?.[0] || currentTls.serverName || '', dest: currentReality.dest || '', fingerprint: currentReality.settings?.fingerprint || 'chrome', flow: currentClient.flow ?? 'xtls-rprx-vision', email: currentClient.email || '', certPath: currentCertificate.certificateFile || '', keyPath: currentCertificate.keyFile || '', path: currentStream.wsSettings?.path || '/vless', host: currentStream.wsSettings?.headers?.Host || '', serviceName: currentStream.grpcSettings?.serviceName || 'vless-grpc', method: existing.settings?.method || '2022-blake3-aes-128-gcm', ...data, protocol: existing.protocol };
  const candidate = buildNode(merged, existing.id, existing.status);
  if (!candidate) return null;
  const generatedPrimaryEmail = candidate.settings?.clients?.[0]?.email;
  candidate.settings = JSON.parse(JSON.stringify(existing.settings || candidate.settings));
  candidate.streamSettings = JSON.parse(JSON.stringify(existing.streamSettings || candidate.streamSettings));
  if (Object.prototype.hasOwnProperty.call(data, 'email') && candidate.settings.clients?.[0] && generatedPrimaryEmail) candidate.settings.clients[0].email = generatedPrimaryEmail;
  if (candidate.security === 'Reality') { const generated = buildNode(merged, existing.id, existing.status); const oldReality = candidate.streamSettings.realitySettings || {}; const nextReality = generated.streamSettings.realitySettings || {}; const nextFlow = Object.prototype.hasOwnProperty.call(data, 'flow') && typeof data.flow === 'string' ? cleanText(data.flow, '', 128) : (currentClient.flow ?? 'xtls-rprx-vision'); oldReality.dest = nextReality.dest; oldReality.serverNames = nextReality.serverNames; oldReality.settings = { ...(oldReality.settings || {}), fingerprint: nextReality.settings?.fingerprint || 'chrome', serverName: nextReality.settings?.serverName || '' }; candidate.streamSettings.realitySettings = oldReality; for (const client of candidate.settings.clients || []) client.flow = nextFlow; }
  if (candidate.streamSettings.security === 'tls') { const generated = buildNode(merged, existing.id, existing.status); candidate.streamSettings.tlsSettings = { ...(candidate.streamSettings.tlsSettings || {}), serverName: generated.streamSettings.tlsSettings?.serverName || candidate.serverAddress, ...(generated.streamSettings.tlsSettings?.certificates ? { certificates: generated.streamSettings.tlsSettings.certificates } : {}) }; if (candidate.streamSettings.network === 'ws') candidate.streamSettings.wsSettings = generated.streamSettings.wsSettings; if (candidate.streamSettings.network === 'grpc') candidate.streamSettings.grpcSettings = generated.streamSettings.grpcSettings; }
  if (candidate.protocolCode === 'shadowsocks') { const generated = buildNode(merged, existing.id, existing.status); const currentMethod = candidate.settings.method; const nextMethod = generated.settings.method; if (currentMethod !== nextMethod && ss2022KeyBytes(currentMethod) !== ss2022KeyBytes(nextMethod)) throw new Error('该 Shadowsocks 方法需要不同长度的密钥；为避免静默轮换客户端凭据，请新建节点'); candidate.settings.method = nextMethod; }
  candidate.xray = { ...candidate.xray, settings: candidate.settings, streamSettings: candidate.streamSettings };
  candidate.shareLink = shareLinkForInbound(candidate);
  return candidate;
}
const seedInbounds = [];
function normalizeInbound(item) {
  if (!item || typeof item !== 'object' || item.shareLink) return item;
  return buildNode({ name: item.name || item.remark || `Inbound ${item.port || ''}`, protocol: protocols.has(item.protocol) ? item.protocol : 'VLESS + Reality', port: item.port, serverAddress: item.serverAddress || 'example.com', sni: item.sni || 'www.microsoft.com', dest: item.dest || 'www.microsoft.com:443', remark: item.remark || '' }, item.id || id(), item.status || 'running') || item;
}
function accessClientKey(protocolCode) { return protocolCode === 'vless' ? 'id' : 'password'; }
function accessLinkForInbound(inbound, client, shareLabel) {
  if (!client) return '';
  const stream = inbound.streamSettings || {};
  if (inbound.protocolCode === 'vless' && client.id) {
    if (inbound.security === 'Reality') {
      const reality = stream.realitySettings || {}; const sni = reality.serverNames?.[0] || ''; const sid = reality.shortIds?.[0] || ''; const config = reality.settings || {}; const flow = client.flow ?? inbound.settings.clients?.[0]?.flow ?? 'xtls-rprx-vision';
      return `vless://${client.id}@${inbound.serverAddress}:${inbound.port}?type=tcp&encryption=none&security=reality&pbk=${config.publicKey || ''}&fp=${config.fingerprint || 'chrome'}&sni=${encodeURIComponent(sni)}&sid=${sid}&spx=%2F&flow=${flow}#${shareName(shareLabel)}`;
    }
    return vlessTransportShareLink(client.id, inbound.serverAddress, inbound.port, shareLabel, stream);
  }
  if (inbound.protocolCode === 'trojan' && client.password) {
    const tls = stream.security === 'tls'; const sniQuery = tls ? `&sni=${encodeURIComponent(stream.tlsSettings?.serverName || inbound.serverAddress)}` : '';
    return `trojan://${client.password}@${inbound.serverAddress}:${inbound.port}?security=${tls ? 'tls' : 'none'}&type=tcp${sniQuery}#${shareName(shareLabel)}`;
  }
  if (inbound.protocolCode === 'shadowsocks' && client.password) {
    const method = inbound.settings.method; const credentials = Buffer.from(`${method}:${inbound.settings.password}:${client.password}`).toString('base64url');
    return `ss://${credentials}@${inbound.serverAddress}:${inbound.port}#${shareName(shareLabel)}`;
  }
  return '';
}
function userAccessForInbound(inbound, user) {
  const email = user.email; let client;
  if (inbound.protocolCode === 'vless') { client = { id: crypto.randomUUID(), email }; if (inbound.security === 'Reality') client.flow = inbound.settings.clients?.[0]?.flow ?? 'xtls-rprx-vision'; }
  else if (inbound.protocolCode === 'trojan') client = { password: token(18), email };
  else if (inbound.protocolCode === 'shadowsocks') client = { password: ss2022Key(inbound.settings.method), email, level: 0 };
  if (!client) return null;
  const link = accessLinkForInbound(inbound, client, `${inbound.name}-${user.name}`); if (!link) return null;
  return { inboundId: inbound.id, protocol: inbound.protocol, protocolCode: inbound.protocolCode, client, link };
}
function refreshUserAccessLinks(inbound) {
  const users = readStore(userFile, seedUsers); let changed = false;
  for (const user of users) for (const access of user.access || []) {
    if (access.inboundId !== inbound.id) continue;
    if (inbound.security === 'Reality' && access.client) { const flow = inbound.settings.clients?.[0]?.flow ?? 'xtls-rprx-vision'; if (access.client.flow !== flow) { access.client.flow = flow; changed = true; } }
    const link = accessLinkForInbound(inbound, access.client, `${inbound.name}-${user.name}`); if (!link) continue;
    if (access.link !== link || access.protocol !== inbound.protocol || access.protocolCode !== inbound.protocolCode) { access.link = link; access.protocol = inbound.protocol; access.protocolCode = inbound.protocolCode; changed = true; }
  }
  if (changed) writeStore(userFile, users); return changed;
}function setAccessActive(inbound, access, active) {
  if (!inbound?.settings?.clients || !access?.client) return;
  const key = accessClientKey(inbound.protocolCode); const exists = inbound.settings.clients.some(item => item[key] === access.client[key]);
  if (active && !exists) inbound.settings.clients.push(access.client);
  if (!active && exists) inbound.settings.clients = inbound.settings.clients.filter(item => item[key] !== access.client[key]);
  if (inbound.xray) inbound.xray.settings = inbound.settings;
}function normalizeExpire(value) {
  const expire = cleanText(value, '', 11); if (!expire) return '';
  const match = expire.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]); const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? expire : null;
}
function userExpired(user, now = Date.now()) { const expire = normalizeExpire(user?.expire); return Boolean(expire) && Date.parse(`${expire}T23:59:59.999`) < now; }
async function reconcileExpiredUsers() {
  const users = readStore(userFile, seedUsers); const expired = users.filter(user => user.status !== 'stopped' && userExpired(user)); if (!expired.length) return users;
  const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound);
  for (const user of expired) { user.status = 'stopped'; for (const access of user.access || []) setAccessActive(inbounds.find(item => item.id === access.inboundId), access, false); }
  writeStore(userFile, users); writeStore(inboundFile, inbounds); await syncRuntimeIfRunning(); return users;
}
function createUser(data) {
  if (!validText(data.name) || !validText(data.email, 100)) return null;
  const email = data.email.trim().toLowerCase(); const expire = normalizeExpire(data.expire);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || expire === null || (expire && userExpired({ expire }))) return null;
  const limitGB = data.limitGB === undefined ? 100 : Number(data.limitGB);
  if (!Number.isFinite(limitGB) || limitGB <= 0) return null;
  return { id: id(), name: data.name.trim(), email, limitGB: Math.round(limitGB * 1000) / 1000, usedGB: 0, expire, status: 'running', createdAt: new Date().toISOString(), access: [] };
}
function controllerHostIsLoopback(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.split('.')[0] === '127');
}
function controllerUrl(value, legacy = false) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (!legacy && (url.pathname !== '/' || url.search || url.hash || (url.protocol === 'http:' && !controllerHostIsLoopback(url.hostname)))) return '';
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}
function controllerUrlSecure(value) { return Boolean(controllerUrl(value)); }
function socketAddressIsLoopback(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '::1' || (net.isIP(value) === 4 && value.split('.')[0] === '127');
}
function agentHeartbeatTransportSecure(req, agent) {
  if (requestIsSecure(req)) return true;
  try {
    const target = new URL(agent.controllerUrl);
    return target.protocol === 'http:' && controllerHostIsLoopback(target.hostname) && socketAddressIsLoopback(req.socket?.remoteAddress);
  } catch { return false; }
}
function normalizeAgentInboundStates(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 1000).map(item => ({ id: Number(item?.id), revision: cleanText(item?.revision, '', 128), status: ['running', 'starting', 'stopped', 'error'].includes(item?.status) ? item.status : 'stopped', lastError: cleanText(item?.lastError, '', 500), updatedAt: cleanText(item?.updatedAt, '', 64) })).filter(item => Number.isInteger(item.id));
}function normalizeAgentRelayStates(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 1000).map(item => ({ id: Number(item?.id), revision: cleanText(item?.revision, '', 128), status: ['running', 'starting', 'stopped', 'error'].includes(item?.status) ? item.status : 'stopped', lastError: cleanText(item?.lastError, '', 500), bytesIn: Math.max(0, Number(item?.bytesIn || 0)), bytesOut: Math.max(0, Number(item?.bytesOut || 0)), connections: Math.max(0, Number(item?.connections || 0)), updatedAt: cleanText(item?.updatedAt, '', 64) })).filter(item => Number.isInteger(item.id));
}
function normalizeAgent(item) {
  if (!item || typeof item !== 'object' || !validText(item.id, 80) || !validText(item.token, 160)) return null;
  return { id: item.id, token: item.token, name: cleanText(item.name, 'Unnamed Agent', 80), controllerUrl: controllerUrl(item.controllerUrl, true), enabled: item.enabled !== false, version: cleanText(item.version, '', 60), hostname: cleanText(item.hostname, '', 120), platform: cleanText(item.platform, '', 80), arch: cleanText(item.arch, '', 40), nodeVersion: cleanText(item.nodeVersion, '', 40), uptimeSeconds: Math.max(0, Number(item.uptimeSeconds || 0)), memoryTotal: Math.max(0, Number(item.memoryTotal || 0)), memoryFree: Math.max(0, Number(item.memoryFree || 0)), cpus: Math.max(0, Number(item.cpus || 0)), addresses: Array.isArray(item.addresses) ? item.addresses.filter(value => validText(value, 80)).slice(0, 20) : [], processId: Math.max(0, Number(item.processId || 0)), agentStartedAt: cleanText(item.agentStartedAt, '', 64), updateRequestId: cleanText(item.updateRequestId, '', 64), updateRequestedAt: cleanText(item.updateRequestedAt, '', 64), updateError: cleanText(item.updateError, '', 500), lastUpdatedAt: cleanText(item.lastUpdatedAt, '', 64), xrayAvailable: item.xrayAvailable === true, xrayVersion: cleanText(item.xrayVersion, '', 100), xrayInstallRequestId: cleanText(item.xrayInstallRequestId, '', 64), xrayInstallRequestedAt: cleanText(item.xrayInstallRequestedAt, '', 64), xrayInstalling: item.xrayInstalling === true, xrayInstallError: cleanText(item.xrayInstallError, '', 500), xrayInstalledAt: cleanText(item.xrayInstalledAt, '', 64), inboundStates: normalizeAgentInboundStates(item.inboundStates), lastSeenAt: cleanText(item.lastSeenAt, '', 64), disableRequestedAt: cleanText(item.disableRequestedAt, '', 64), disabledAckAt: cleanText(item.disabledAckAt, '', 64), lastDisabledSeenAt: cleanText(item.lastDisabledSeenAt, '', 64), maintenanceCancelledAt: cleanText(item.maintenanceCancelledAt, '', 64), maintenanceCancelledReason: cleanText(item.maintenanceCancelledReason, '', 240), createdAt: cleanText(item.createdAt, new Date().toISOString(), 64), updatedAt: cleanText(item.updatedAt, '', 64), lastHeartbeatSecure: item.lastHeartbeatSecure === false ? false : item.lastHeartbeatSecure === true ? true : null, relayStates: normalizeAgentRelayStates(item.relayStates) };
}function readAgents() { return readStore(agentFile, [], normalizeAgent).filter(Boolean); }
function agentStatus(agent) { if (!agent.enabled) return 'disabled'; const seen = Date.parse(agent.lastSeenAt || ''); return Number.isFinite(seen) && Date.now() - seen < 90 * 1000 ? 'online' : 'offline'; }
function agentDisablePending(agent) { return Boolean(agent && !agent.enabled && !agent.disabledAckAt); }
function agentWorkloadsStopConfirmed(agent) { return Boolean(agent && !agent.enabled && agent.disabledAckAt); }
function agentPublic(agent) { const { token: hidden, updateRequestId: hiddenUpdate, xrayInstallRequestId: hiddenXrayInstall, ...safe } = agent; return { ...safe, controllerSecure: controllerUrlSecure(agent.controllerUrl) && agent.lastHeartbeatSecure !== false, status: agentStatus(agent), updatePending: Boolean(agent.updateRequestId), xrayInstallPending: Boolean(agent.xrayInstallRequestId), safeStopAckCapable: agentSupportsWorkloadStopAck(agent) }; }
function secureTokenMatch(expected, actual) { if (typeof actual !== 'string' || expected.length !== actual.length) return false; return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual)); }
function agentServiceName(agent) { return `3xui-lite-agent-${agent.id}`; }
function agentInstallScript(agent) {
  const serviceName = agentServiceName(agent); const installDir = `/opt/${serviceName}`; const serviceFile = `/etc/systemd/system/${serviceName}.service`; const environmentFile = `${installDir}/agent.env`; const environmentPayload = Buffer.from(`AGENT_CONTROLLER=${agent.controllerUrl}\nAGENT_ID=${agent.id}\nAGENT_TOKEN=${agent.token}\n`).toString('base64');
  return `#!/usr/bin/env bash
set -euo pipefail
install_dir=${JSON.stringify(installDir)}
service_file=${JSON.stringify(serviceFile)}
environment_file=${JSON.stringify(environmentFile)}
install_node() {
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [ "$node_major" -eq 22 ] || [ "$node_major" -eq 24 ]; then return; fi
  fi
  echo "正在安装 Node.js 24 LTS..."
  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y ca-certificates curl && curl --retry 5 --retry-delay 2 --retry-connrefused --connect-timeout 15 --max-time 120 -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl && curl --retry 5 --retry-delay 2 --retry-connrefused --connect-timeout 15 --max-time 120 -fsSL https://rpm.nodesource.com/setup_24.x | bash - && dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl && curl --retry 5 --retry-delay 2 --retry-connrefused --connect-timeout 15 --max-time 120 -fsSL https://rpm.nodesource.com/setup_24.x | bash - && yum install -y nodejs
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs npm curl ca-certificates
  else echo "未找到受支持的软件包管理器，请先安装 Node.js 22 LTS 或 24 LTS。"; exit 1; fi
}
install_node
node_major=0
if command -v node >/dev/null 2>&1; then node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"; fi
if [ "$node_major" -ne 22 ] && [ "$node_major" -ne 24 ]; then echo "Agent 仅支持 Node.js 22 或 24 LTS。"; exit 1; fi
if ! command -v curl >/dev/null 2>&1; then echo "缺少 curl，无法下载 Agent 脚本。"; exit 1; fi
mkdir -p "$install_dir"
agent_tmp_base="$(mktemp "$install_dir/.agent.XXXXXX")"
agent_tmp="$agent_tmp_base.js"
cleanup_agent_tmp() { rm -f "$agent_tmp_base" "$agent_tmp"; }
trap cleanup_agent_tmp EXIT
mv -f "$agent_tmp_base" "$agent_tmp"
chmod 600 "$agent_tmp"
curl --retry 5 --retry-delay 2 --retry-connrefused --connect-timeout 15 --max-time 120 -fsSL ${JSON.stringify(`${agent.controllerUrl}/agent.js`)} -o "$agent_tmp"
node --check "$agent_tmp"
chmod 700 "$agent_tmp"
mv -f "$agent_tmp" "$install_dir/agent.js"
trap - EXIT
printf '%s' ${JSON.stringify(environmentPayload)} | base64 -d > "$environment_file"
chmod 600 "$environment_file"
cat > "$service_file" <<'UNIT'
[Unit]
Description=3xUI Lite Agent (${agent.name.replace(/[\r\n]/g, ' ')})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${installDir}
EnvironmentFile=${environmentFile}
ExecStart=/usr/bin/env node ${installDir}/agent.js
Restart=always
RestartSec=5
RestartPreventExitStatus=1
UMask=0077
PrivateTmp=true
ProtectHome=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
chmod 600 "$service_file"
systemctl daemon-reload
systemctl enable ${serviceName}
systemctl restart ${serviceName}
systemctl --no-pager --full status ${serviceName}`;
}
function agentCommand(agent) { return `echo ${Buffer.from(agentInstallScript(agent)).toString('base64')} | base64 -d | sudo bash`; }
function createAgent(data) {
  const name = cleanText(data.name, '', 80); const target = controllerUrl(data.controllerUrl);
  if (!name || !target) return null;
  const now = new Date().toISOString(); return { id: `agent-${token(9)}`, token: token(32), name, controllerUrl: target, enabled: true, version: '', hostname: '', platform: '', arch: '', nodeVersion: '', lastSeenAt: '', createdAt: now, updatedAt: now };
}
function inboundRevision(inbound) {
  const payload = { id: Number(inbound.id), name: cleanText(inbound.name, '', 200), port: Number(inbound.port), xray: inbound.xray };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
function agentInboundTasks(agentId) {
  return readStore(inboundFile, seedInbounds, normalizeInbound)
    .filter(inbound => inbound.agentId === agentId && inbound.status === 'running' && !inboundTlsError(inbound))
    .map(inbound => ({ id: inbound.id, revision: inboundRevision(inbound), name: inbound.name, port: inbound.port, xray: inbound.xray }));
}
function relayRevision(rule) {
  const payload = { id: Number(rule.id), name: cleanText(rule.name, '', 200), transport: rule.transport, listenPort: Number(rule.listenPort), bindAddress: rule.bindAddress, targetHost: rule.targetHost, targetPort: Number(rule.targetPort) };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
function agentRelayTasks(agentId) {
  return readStore(relayFile, seedRelays, normalizeRelay)
    .filter(rule => rule.agentId === agentId && (rule.status === 'running' || rule.pendingRemoteAction))
    .map(rule => rule.pendingRemoteAction
      ? { id: rule.id, revision: rule.pendingRemoteRevision, tombstone: true, action: rule.pendingRemoteAction }
      : { id: rule.id, revision: relayRevision(rule), name: rule.name, transport: rule.transport, listenPort: rule.listenPort, bindAddress: rule.bindAddress, targetHost: rule.targetHost, targetPort: rule.targetPort });
}
function requestRemoteRelayControl(rule, action) {
  if (rule.pendingRemoteAction === action && rule.pendingRemoteRevision) return rule;
  const now = new Date().toISOString();
  rule.status = 'stopped';
  rule.runtimeStatus = 'stopping';
  rule.lastError = '';
  rule.pendingRemoteAction = action;
  rule.pendingRemoteRevision = token(18);
  rule.pendingRemoteRequestedAt = now;
  rule.pendingRemoteDeliveredAt = '';
  rule.updatedAt = now;
  return rule;
}
function clearRemoteRelayControl(rule) {
  rule.pendingRemoteAction = '';
  rule.pendingRemoteRevision = '';
  rule.pendingRemoteRequestedAt = '';
  rule.pendingRemoteDeliveredAt = '';
  return rule;
}
function reconcileAgentRelayControls(agent, states) {
  const reportedById = new Map((Array.isArray(states) ? states : []).map(state => [Number(state.id), state]));
  const relays = readStore(relayFile, seedRelays, normalizeRelay);
  let changed = false;
  for (let index = relays.length - 1; index >= 0; index--) {
    const rule = relays[index];
    if (rule.agentId !== agent.id || !rule.pendingRemoteAction || !rule.pendingRemoteRevision) continue;
    const reported = reportedById.get(Number(rule.id));
    const explicitAck = agentSupportsWorkloadStopAck(agent) && reported?.revision === rule.pendingRemoteRevision && reported?.status === 'stopped';
    if (!explicitAck) continue;
    if (rule.pendingRemoteAction === 'delete') relays.splice(index, 1);
    else {
      clearRemoteRelayControl(rule);
      rule.runtimeStatus = 'stopped';
      rule.lastError = '';
      rule.updatedAt = new Date().toISOString();
    }
    changed = true;
  }
  if (changed) writeStore(relayFile, relays);
  return changed;
}
function settleAgentRelayControlsAfterDisableAck(agentId) {
  const relays = readStore(relayFile, seedRelays, normalizeRelay); let changed = false;
  for (let index = relays.length - 1; index >= 0; index--) {
    const rule = relays[index]; if (rule.agentId !== agentId || !rule.pendingRemoteAction) continue;
    if (rule.pendingRemoteAction === 'delete') relays.splice(index, 1);
    else { clearRemoteRelayControl(rule); rule.status = 'stopped'; rule.runtimeStatus = 'stopped'; rule.lastError = ''; rule.updatedAt = new Date().toISOString(); }
    changed = true;
  }
  if (changed) writeStore(relayFile, relays);
  return changed;
}
function markAgentRelayControlsDelivered(agentId) {
  const relays = readStore(relayFile, seedRelays, normalizeRelay);
  const now = new Date().toISOString();
  let changed = false;
  for (const rule of relays) {
    if (rule.agentId !== agentId || !rule.pendingRemoteAction || rule.pendingRemoteDeliveredAt) continue;
    rule.pendingRemoteDeliveredAt = now;
    rule.updatedAt = now;
    changed = true;
  }
  if (changed) writeStore(relayFile, relays);
  return changed;
}
function recordDisabledAgentHeartbeat(agent, agents, info) {
  const now = new Date().toISOString();
  agent.version = cleanText(info?.version, agent.version, 60); agent.agentStartedAt = cleanText(info?.agentStartedAt, agent.agentStartedAt, 64); agent.processId = Math.max(0, Number(info?.processId || 0)); agent.xrayAvailable = info?.xrayAvailable === true; agent.xrayVersion = cleanText(info?.xrayVersion, agent.xrayVersion, 100); agent.xrayInstalling = info?.xrayInstalling === true;
  const inboundStates = normalizeAgentInboundStates(info?.inboundStates);
  const relayStates = normalizeAgentRelayStates(info?.relayStates);
  reconcileAgentRelayControls(agent, relayStates);
  agent.inboundStates = inboundStates;
  agent.relayStates = relayStates;
  agent.lastDisabledSeenAt = now;
  const workloadActive = inboundStates.some(state => state.status !== 'stopped') || relayStates.some(state => state.status !== 'stopped') || info?.xrayInstalling === true;
  if (!workloadActive && agentSupportsWorkloadStopAck(agent) && !agent.disabledAckAt) { agent.disabledAckAt = now; settleAgentRelayControlsAfterDisableAck(agent.id); }
  agent.updatedAt = now;
  writeStore(agentFile, agents);
  markAgentRelayControlsDelivered(agent.id);
}
async function handleAgentGateway(req, res, parts) {
  if (parts.length !== 3 || parts[2] !== 'heartbeat' || req.method !== 'POST') return json(res, 404, { error: 'Not found' });
  const data = await body(req); const agentId = cleanText(data.id, '', 80); const supplied = cleanText(data.token, '', 160); let agents = readAgents(); let agent = agents.find(item => item.id === agentId);
  if (!agent || !secureTokenMatch(agent.token, supplied)) return json(res, 401, { error: 'Agent 身份验证失败' });
  const info = data.info && typeof data.info === 'object' ? data.info : data;
  if (!agent.enabled) {
    recordDisabledAgentHeartbeat(agent, agents, info);
    return json(res, 403, { error: '该 Agent 已被面板停用' });
  }
  if (!controllerUrlSecure(agent.controllerUrl) || !agentHeartbeatTransportSecure(req, agent)) {
    agent.lastHeartbeatSecure = false; agent.updatedAt = new Date().toISOString(); writeStore(agentFile, agents);
    return json(res, 426, { error: 'Agent 控制通道不安全：请将控制面板地址迁移到 HTTPS（仅本机回环地址允许 HTTP）', code: 'CONTROLLER_HTTPS_REQUIRED' });
  }
  await reconcileExpiredUsers();
  agents = readAgents(); agent = agents.find(item => item.id === agentId);
  if (!agent || !secureTokenMatch(agent.token, supplied)) return json(res, 401, { error: 'Agent 身份验证失败' });
  if (!agent.enabled) {
    recordDisabledAgentHeartbeat(agent, agents, info);
    return json(res, 403, { error: '该 Agent 已被面板停用' });
  }
  const updateAck = cleanText(info.updateAck, '', 64); const updateFailedId = cleanText(info.updateFailedId, '', 64); const updateError = cleanText(info.updateError, '', 500);
  if (agent.updateRequestId && updateAck === agent.updateRequestId) { agent.lastUpdatedAt = new Date().toISOString(); agent.updateRequestId = ''; agent.updateRequestedAt = ''; agent.updateError = ''; }
  else if (agent.updateRequestId && updateFailedId === agent.updateRequestId) { agent.updateRequestId = ''; agent.updateRequestedAt = ''; agent.updateError = updateError || 'Agent 更新失败'; }
  const xrayInstallAck = cleanText(info.xrayInstallAck, '', 64); const xrayInstallFailedId = cleanText(info.xrayInstallFailedId, '', 64); const xrayInstallError = cleanText(info.xrayInstallError, '', 500);
  if (agent.xrayInstallRequestId && xrayInstallAck === agent.xrayInstallRequestId) { agent.xrayInstalledAt = new Date().toISOString(); agent.xrayInstallRequestId = ''; agent.xrayInstallRequestedAt = ''; agent.xrayInstallError = ''; }
  else if (agent.xrayInstallRequestId && xrayInstallFailedId === agent.xrayInstallRequestId) { agent.xrayInstallRequestId = ''; agent.xrayInstallRequestedAt = ''; agent.xrayInstallError = xrayInstallError || 'Xray Core 安装失败'; }
  const inboundStates = normalizeAgentInboundStates(info.inboundStates);
  const relayStates = normalizeAgentRelayStates(info.relayStates);
  agent.version = cleanText(info.version, agent.version, 60);
  reconcileAgentRelayControls(agent, relayStates);
  agent.version = cleanText(info.version, agent.version, 60); agent.hostname = cleanText(info.hostname, agent.hostname, 120); agent.platform = cleanText(info.platform, agent.platform, 80); agent.arch = cleanText(info.arch, agent.arch, 40); agent.nodeVersion = cleanText(info.nodeVersion, agent.nodeVersion, 40); agent.uptimeSeconds = Math.max(0, Number(info.uptimeSeconds || 0)); agent.memoryTotal = Math.max(0, Number(info.memoryTotal || 0)); agent.memoryFree = Math.max(0, Number(info.memoryFree || 0)); agent.cpus = Math.max(0, Number(info.cpus || 0)); agent.addresses = Array.isArray(info.addresses) ? info.addresses.filter(value => validText(value, 80)).slice(0, 20) : []; agent.processId = Math.max(0, Number(info.processId || 0)); agent.agentStartedAt = cleanText(info.agentStartedAt, agent.agentStartedAt, 64); agent.xrayAvailable = info.xrayAvailable === true; agent.xrayVersion = cleanText(info.xrayVersion, agent.xrayVersion, 100); agent.xrayInstalling = info.xrayInstalling === true; agent.inboundStates = inboundStates; agent.relayStates = relayStates; agent.lastHeartbeatSecure = true; agent.lastSeenAt = new Date().toISOString(); agent.updatedAt = agent.lastSeenAt;
  writeStore(agentFile, agents);
  const payload = { ok: true, intervalSeconds: 15, relays: agentRelayTasks(agent.id), inbounds: agentInboundTasks(agent.id), xrayInstall: agent.xrayInstallRequestId ? { id: agent.xrayInstallRequestId, version: 'latest' } : null, update: agent.updateRequestId ? { id: agent.updateRequestId, url: `${agent.controllerUrl}/agent.js` } : null, agent: agentPublic(agent) };
  json(res, 200, payload);
  markAgentRelayControlsDelivered(agent.id);
  return undefined;
}async function handleAgents(req, res, parts) {
  const agentId = cleanText(parts[2], '', 80);
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, readAgents().map(agentPublic));
  if (parts.length === 2 && req.method === 'POST') {
    const data = await body(req);
    if (!cleanText(data.name, '', 80)) return json(res, 400, { error: '机器名称不能为空' });
    if (!controllerUrl(data.controllerUrl)) return json(res, 400, { error: '控制面板地址必须为无账号、无路径、无查询参数的 HTTPS 根地址；仅 localhost、127.0.0.0/8 或 [::1] 可使用 HTTP' });
    const agent = createAgent(data); const agents = readAgents(); agents.unshift(agent); writeStore(agentFile, agents); return json(res, 201, { agent: agentPublic(agent), deployment: { command: agentCommand(agent), controllerUrl: agent.controllerUrl, id: agent.id, token: agent.token } });
  }
  const patchData = req.method === 'PATCH' ? await body(req) : null; const agents = readAgents(); const agent = agents.find(item => item.id === agentId); if (!agent) return json(res, 404, { error: 'Not found' });
  if (parts.length === 5 && parts[3] === 'xray' && parts[4] === 'install' && req.method === 'POST') {
    if (!agent.enabled) return json(res, 409, { error: 'Agent 已停用，无法下发维护任务', agent: agentPublic(agent) });
    if (agentStatus(agent) !== 'online') return json(res, 409, { error: 'Agent 当前离线，请等待心跳恢复后再安装 Xray Core', agent: agentPublic(agent) });
    if (agent.updateRequestId) return json(res, 409, { error: 'Agent 更新任务执行期间不能安装 Xray Core', agent: agentPublic(agent) });
    if (agent.xrayInstallRequestId || agent.xrayInstalling) return json(res, 409, { error: '该 Agent 已有正在等待或执行的 Xray Core 安装任务', agent: agentPublic(agent) });
    agent.xrayInstallRequestId = token(12); agent.xrayInstallRequestedAt = new Date().toISOString(); agent.xrayInstallError = ''; agent.maintenanceCancelledAt = ''; agent.maintenanceCancelledReason = ''; agent.updatedAt = agent.xrayInstallRequestedAt; writeStore(agentFile, agents); return json(res, 202, { agent: agentPublic(agent), message: '已下发 Xray Core 安装任务，等待 Agent 执行。' });
  }
  if (parts.length === 4 && parts[3] === 'update' && req.method === 'POST') {
    if (!agent.enabled) return json(res, 409, { error: 'Agent 已停用，无法下发维护任务', agent: agentPublic(agent) });
    if (agentStatus(agent) !== 'online') return json(res, 409, { error: 'Agent 当前离线，请等待心跳恢复后再更新', agent: agentPublic(agent) });
    if (agent.xrayInstallRequestId || agent.xrayInstalling) return json(res, 409, { error: 'Xray Core 安装期间不能更新 Agent', agent: agentPublic(agent) });
    if (agent.updateRequestId) return json(res, 409, { error: '该 Agent 已有待执行的更新任务', agent: agentPublic(agent) });
    agent.updateRequestId = token(12); agent.updateRequestedAt = new Date().toISOString(); agent.updateError = ''; agent.maintenanceCancelledAt = ''; agent.maintenanceCancelledReason = ''; agent.updatedAt = agent.updateRequestedAt; writeStore(agentFile, agents); return json(res, 202, { agent: agentPublic(agent), message: '已下发更新请求，等待 Agent 心跳执行。' });
  }
  if (parts.length === 4 && parts[3] === 'bootstrap' && req.method === 'GET') { auditOnFinish(req, res, currentSession(req), 'admin.agent.bootstrap.read', `/api/agents/${agent.id}/bootstrap`); return json(res, 200, { command: agentCommand(agent), controllerUrl: agent.controllerUrl, id: agent.id, token: agent.token }); }
  if (req.method === 'PATCH') {
    const data = patchData;
    const maintenanceBusy = Boolean(agent.updateRequestId || agent.xrayInstallRequestId || agent.xrayInstalling);
    if (data.rotateToken === true && maintenanceBusy) return json(res, 409, { error: '维护任务执行期间不能轮换 Agent 令牌', agent: agentPublic(agent) });
    if (data.enabled !== undefined) {
      const nextEnabled = Boolean(data.enabled);
      if (nextEnabled !== agent.enabled) {
        const now = new Date().toISOString();
        agent.enabled = nextEnabled;
        if (nextEnabled) {
          agent.lastSeenAt = '';
          agent.disableRequestedAt = '';
          agent.disabledAckAt = '';
          agent.lastDisabledSeenAt = '';
        } else {
          agent.disableRequestedAt = now;
          agent.disabledAckAt = '';
          if (maintenanceBusy) {
            agent.updateRequestId = '';
            agent.updateRequestedAt = '';
            agent.xrayInstallRequestId = '';
            agent.xrayInstallRequestedAt = '';
            agent.maintenanceCancelledAt = now;
            agent.maintenanceCancelledReason = '管理员停用 Agent，已撤销未确认的维护任务';
          }
        }
      }
    }
    if (data.controllerUrl !== undefined) {
      const target = controllerUrl(data.controllerUrl);
      if (!target) return json(res, 400, { error: '控制面板地址必须为无账号、无路径、无查询参数的 HTTPS 根地址；仅 localhost、127.0.0.0/8 或 [::1] 可使用 HTTP' });
      if (target !== agent.controllerUrl) { agent.controllerUrl = target; agent.lastSeenAt = ''; }
    }
    if (data.name !== undefined) {
      const name = cleanText(data.name, '', 80);
      if (!name) return json(res, 400, { error: '机器名称不能为空' });
      agent.name = name;
    }
    if (data.rotateToken === true) { agent.token = token(32); agent.lastSeenAt = ''; }
    agent.updatedAt = new Date().toISOString();
    writeStore(agentFile, agents);
    return json(res, 200, { agent: agentPublic(agent), deployment: (data.rotateToken === true || data.controllerUrl !== undefined) ? { command: agentCommand(agent), controllerUrl: agent.controllerUrl, id: agent.id, token: agent.token } : undefined });
  }
  if (req.method === 'DELETE') { const assignedInbounds = readStore(inboundFile, seedInbounds, normalizeInbound).filter(item => item.agentId === agentId); const assignedRelays = readStore(relayFile, seedRelays, normalizeRelay).filter(item => item.agentId === agentId); if (assignedInbounds.length || assignedRelays.length) return json(res, 409, { error: '该 Agent 仍承载 ' + assignedInbounds.length + ' 个入站和 ' + assignedRelays.length + ' 条中转，请先迁移或删除这些资源' }); writeStore(agentFile, agents.filter(item => item.id !== agentId)); return json(res, 204); }
  return json(res, 405, { error: 'Method not allowed' });
}function normalizeRelay(item) {
  if (!item || typeof item !== 'object') return item;
  if (Number.isInteger(Number(item.listenPort)) && validText(item.targetHost) && Number.isInteger(Number(item.targetPort))) return { ...item, listenPort: Number(item.listenPort), targetPort: Number(item.targetPort), transport: ['tcp', 'udp', 'tcp+udp'].includes(item.transport) ? item.transport : 'tcp', bindAddress: cleanText(item.bindAddress, '0.0.0.0', 80), agentId: cleanText(item.agentId, '', 80), runtimeStatus: item.runtimeStatus || 'stopped', lastError: item.lastError || '', bytesIn: Number(item.bytesIn || 0), bytesOut: Number(item.bytesOut || 0), connections: Number(item.connections || 0), pendingRemoteAction: ['stop', 'delete'].includes(item.pendingRemoteAction) ? item.pendingRemoteAction : '', pendingRemoteRevision: cleanText(item.pendingRemoteRevision, '', 128), pendingRemoteRequestedAt: cleanText(item.pendingRemoteRequestedAt, '', 64), pendingRemoteDeliveredAt: cleanText(item.pendingRemoteDeliveredAt, '', 64) };
  return { ...item, transport: item.transport || 'tcp', listenPort: null, targetHost: '', targetPort: null, agentId: '', runtimeStatus: 'legacy', lastError: '旧版线路档案：请新建含监听端口与目标地址的转发规则。', bytesIn: 0, bytesOut: 0, connections: 0 };
}
function agentSupportsRelayRevision(agent) {
  const match = String(agent?.version || '').match(/^v?(\d+)\.(\d+)\.(\d+)/); if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number); return major > 0 || minor > 5 || (minor === 5 && patch >= 6);
}
function agentSupportsInboundRevision(agent) {
  const match = String(agent?.version || '').match(/^v?(\d+)\.(\d+)\.(\d+)/); if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number); return major > 0 || minor > 5 || (minor === 5 && patch >= 7);
}
function agentSupportsWorkloadStopAck(agent) {
  const match = String(agent?.version || '').match(/^v?(\d+)\.(\d+)\.(\d+)/); if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number); return major > 0 || minor > 5 || (minor === 5 && patch >= 7);
}
function remoteRelaySnapshot(rule, context) {
  const agent = context?.agentsById ? context.agentsById.get(rule.agentId) : readAgents().find(item => item.id === rule.agentId);
  const agentState = agent?.relayStates?.find(item => item.id === rule.id);
  const revision = relayRevision(rule);
  const appliedRevision = agentState?.revision || '';
  const connectivity = agent ? agentStatus(agent) : 'missing';
  const disablePending = agentDisablePending(agent);
  if (rule.pendingRemoteAction) {
    const actionLabel = rule.pendingRemoteAction === 'delete' ? '删除' : '停止';
    const lastError = !agent
      ? `Agent 不存在，无法确认${actionLabel}远程规则`
      : !agentSupportsWorkloadStopAck(agent)
        ? 'Agent 版本不支持可信停止确认；请通过部署命令升级至 v0.5.7 或更高版本'
        : connectivity === 'online'
        ? `等待 Agent 确认${actionLabel}远程规则`
          : connectivity === 'offline'
            ? `Agent 离线，等待恢复连接后${actionLabel}远程规则`
            : connectivity === 'disabled'
              ? `Agent 已停用，等待其确认工作负载已停止后${actionLabel}远程规则`
              : `Agent 不存在，无法确认${actionLabel}远程规则`;
    return { ...rule, revision, appliedRevision, runtimeStatus: 'stopping', lastError, pendingRemote: true, pendingRemoteDelivered: Boolean(rule.pendingRemoteDeliveredAt), agentStatus: connectivity, bytesIn: Number(agentState?.bytesIn || 0), bytesOut: Number(agentState?.bytesOut || 0), connections: Number(agentState?.connections || 0), agentName: agent?.name || '未知 Agent', agentLastSeenAt: agent?.lastSeenAt || '' };
  }
  const revisionMatches = appliedRevision ? appliedRevision === revision : !agentSupportsRelayRevision(agent);
  if (rule.status === 'running' && disablePending) return { ...rule, revision, appliedRevision, runtimeStatus: 'stopping', lastError: agentSupportsWorkloadStopAck(agent) ? '等待 Agent 确认全部工作负载已停止；确认前远端仍可能继续转发' : 'Agent 版本不支持可信停止确认；请通过部署命令升级至 v0.5.7 或更高版本', pendingDisable: true, agentStatus: connectivity, bytesIn: revisionMatches ? Number(agentState?.bytesIn || 0) : 0, bytesOut: revisionMatches ? Number(agentState?.bytesOut || 0) : 0, connections: revisionMatches ? Number(agentState?.connections || 0) : 0, agentName: agent?.name || '未知 Agent', agentLastSeenAt: agent?.lastSeenAt || '' };
  const status = rule.status !== 'running' ? 'stopped' : !agent ? 'error' : connectivity === 'online' ? (revisionMatches ? (agentState?.status || 'starting') : 'starting') : connectivity;
  const lastError = !revisionMatches ? '' : status === 'error' ? (agentState?.lastError || '远程 Agent 不存在或规则启动失败') : (agentState?.lastError || '');
  return { ...rule, revision, appliedRevision, runtimeStatus: status, lastError, bytesIn: revisionMatches ? Number(agentState?.bytesIn || 0) : 0, bytesOut: revisionMatches ? Number(agentState?.bytesOut || 0) : 0, connections: revisionMatches ? Number(agentState?.connections || 0) : 0, agentName: agent?.name || '未知 Agent', agentLastSeenAt: agent?.lastSeenAt || '' };
}
function relaySnapshot(rule, context) {
  if (rule.agentId) return remoteRelaySnapshot(rule, context);
  const runtime = relayRuntimes.get(rule.id); if (!runtime) {
    if (rule.runtimeStatus === 'legacy') return { ...rule, runtimeStatus: 'legacy' };
    if (rule.runtimeStatus === 'error' || rule.status === 'running') return { ...rule, runtimeStatus: 'error', lastError: rule.lastError || '规则已启用，但监听进程未运行' };
    return { ...rule, runtimeStatus: 'stopped' };
  }
  return { ...rule, runtimeStatus: runtime.status, lastError: runtime.lastError || rule.lastError || '', bytesIn: runtime.bytesIn, bytesOut: runtime.bytesOut, connections: runtime.connections };
}
function inboundSnapshot(inbound, context) {
  if (!inbound.agentId) {
    if (inbound.status !== 'running') return inbound;
    const tlsError = inboundTlsError(inbound); if (tlsError) return { ...inbound, status: 'error', desiredStatus: inbound.status, lastError: tlsError };
    const info = context?.runtime || runtimeInfo();
    if (!info.available) return { ...inbound, status: 'error', desiredStatus: inbound.status, lastError: info.error || '未检测到 Xray Core' };
    if (!info.running) return { ...inbound, status: 'error', desiredStatus: inbound.status, lastError: info.lastError || 'Xray Core 尚未启动' };
    return { ...inbound, lastError: '' };
  }
  const tlsError = inboundTlsError(inbound); if (tlsError) return { ...inbound, status: 'error', desiredStatus: inbound.status, lastError: tlsError };
  const agent = context?.agentsById ? context.agentsById.get(inbound.agentId) : readAgents().find(item => item.id === inbound.agentId);
  const reported = agent?.inboundStates?.find(item => item.id === inbound.id);
  const revision = inboundRevision(inbound);
  const appliedRevision = reported?.revision || '';
  const revisionMatches = appliedRevision ? appliedRevision === revision : !agentSupportsInboundRevision(agent);
  const connectivity = agent ? agentStatus(agent) : 'missing';
  const disablePending = agentDisablePending(agent);
  const state = inbound.status !== 'running' ? 'stopped' : !agent ? 'error' : disablePending ? 'stopping' : connectivity === 'online' ? (revisionMatches ? (reported?.status || 'starting') : 'starting') : connectivity;
  const lastError = inbound.status !== 'running' ? '' : state === 'stopping' ? (agentSupportsWorkloadStopAck(agent) ? '等待 Agent 确认全部工作负载已停止；确认前远端仍可能继续提供入站' : 'Agent 版本不支持可信停止确认；请通过部署命令升级至 v0.5.7 或更高版本') : !revisionMatches ? '等待 Agent 应用最新入站配置' : state === 'error' ? (reported?.lastError || (agent?.xrayAvailable === false ? 'Agent 未检测到 Xray Core' : '远程节点启动失败')) : state === 'offline' ? 'Agent 离线，等待恢复连接后应用入站配置' : state === 'disabled' ? (agent?.disabledAckAt ? 'Agent 已停用，远端入站已确认停止' : 'Agent 已停用，无法应用入站配置') : (reported?.lastError || '');
  return { ...inbound, revision, appliedRevision, revisionPending: !revisionMatches, pendingDisable: disablePending, status: state, desiredStatus: inbound.status, lastError, agentName: agent?.name || '未知 Agent', agentLastSeenAt: agent?.lastSeenAt || '' };
}function tcpReachable(host, port, timeout = 3500) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port }); let done = false;
    const finish = (ok, message = '') => { if (done) return; done = true; socket.destroy(); resolve({ ok, message }); };
    socket.setTimeout(timeout); socket.once('connect', () => finish(true)); socket.once('timeout', () => finish(false, '连接超时')); socket.once('error', error => finish(false, error.code || error.message));
  });
}
function splitHostPort(value) {
  const target = String(value || '').trim(); const ipv6 = target.match(/^\[([^\]]+)\]:(\d+)$/); if (ipv6) return { host: ipv6[1], port: Number(ipv6[2]) };
  const index = target.lastIndexOf(':'); if (index < 1) return null; const port = Number(target.slice(index + 1)); return Number.isInteger(port) && port > 0 && port < 65536 ? { host: target.slice(0, index), port } : null;
}
async function diagnoseInbound(inbound, repair = false) {
  const checks = []; const add = (name, status, detail) => checks.push({ name, status, detail });
  if (inbound.agentId) {
    const agent = readAgents().find(item => item.id === inbound.agentId); const online = agent && agentStatus(agent) === 'online';
    add('Agent 在线状态', online ? 'ok' : 'error', online ? `${agent.name} 已在线` : '目标 Agent 离线或不存在');
    add('远程端口监听', 'warning', '远程 Agent 暂不支持从面板侧探测；请在该机器上检查防火墙与 Xray 日志。');
    return { ok: online, repaired: false, checks };
  }
  const config = runtimeConfig(); const valid = validateRuntimeConfig(config);
  if (!valid.ok) { add('Xray 配置校验', 'error', valid.error || '配置校验失败'); return { ok: false, repaired: false, checks }; }
  add('Xray 配置校验', 'ok', '当前所有已启用本机入站均通过 Xray 校验');
  let info = runtimeInfo(); let repaired = false;
  if (repair) {
    const result = info.running ? await syncRuntimeIfRunning() : await ensureLocalRuntime(); repaired = Boolean(result.reloaded || result.started);
    info = runtimeInfo(); add('Core 重载', info.running ? 'ok' : 'error', info.running ? (result.reloaded ? '已重载最新配置' : '已启动 Core') : (result.error || info.lastError || 'Core 启动失败'));
  }
  if (!info.available) { add('Xray Core', 'error', info.error || '未检测到 Xray Core'); return { ok: false, repaired, checks }; }
  if (!info.running) { add('Xray Core', 'error', info.lastError || 'Core 未运行，可使用“修复并诊断”尝试启动'); return { ok: false, repaired, checks }; }
  add('Xray Core', 'ok', `正在运行，PID ${info.pid}，已加载 ${info.enabledInbounds} 个入站`);
  const local = await tcpReachable('127.0.0.1', inbound.port); add('本机监听端口', local.ok ? 'ok' : 'error', local.ok ? `127.0.0.1:${inbound.port} 可连接` : `127.0.0.1:${inbound.port} 不可连接：${local.message}`);
  const stream = inbound.streamSettings || {};
  if (stream.security === 'reality') {
    const destination = splitHostPort(stream.realitySettings?.dest);
    if (!destination) add('Reality 伪装站点', 'error', 'Reality dest 格式无效，应为域名:端口');
    else { const target = await tcpReachable(destination.host, destination.port); add('Reality 伪装站点', target.ok ? 'ok' : 'warning', target.ok ? `${destination.host}:${destination.port} 可从 VPS 连接` : `${destination.host}:${destination.port} 不可达：${target.message}`); }
    const reality = stream.realitySettings || {}; if (!reality.privateKey || !reality.settings?.publicKey || !Array.isArray(reality.shortIds) || !reality.shortIds[0]) add('Reality 密钥字段', 'error', '缺少 privateKey、publicKey 或 shortId'); else add('Reality 密钥字段', 'ok', '公私钥与 shortId 已配置');
  }
  if (stream.security === 'tls') {
    const certificate = stream.tlsSettings?.certificates?.[0];
    if (!certificate?.certificateFile || !certificate?.keyFile) add('TLS 证书', 'error', '未配置证书文件；请在系统设置申请/保存证书后点击“应用至 TLS 入站”');
    else if (!fs.existsSync(certificate.certificateFile) || !fs.existsSync(certificate.keyFile)) add('TLS 证书', 'error', '证书或私钥文件路径不存在');
    else add('TLS 证书', 'ok', '证书与私钥文件存在');
  }
  add('公网防火墙', 'warning', `已确认本机监听；仍需在云安全组和系统防火墙放行 TCP ${inbound.port}`);
  return { ok: checks.every(item => item.status !== 'error'), repaired, checks };
}
function relayTraffic(runtime, direction, size) { if (direction === 'in') runtime.bytesIn += size; else runtime.bytesOut += size; }
function createTcpRelay(rule, runtime) {
  const server = net.createServer(client => {
    runtime.connections++; const upstream = net.connect({ host: rule.targetHost, port: rule.targetPort }); let closed = false; runtime.sockets.add(client); runtime.sockets.add(upstream);
    const close = () => { if (closed) return; closed = true; runtime.connections = Math.max(0, runtime.connections - 1); runtime.sockets.delete(client); runtime.sockets.delete(upstream); client.destroy(); upstream.destroy(); };
    client.on('data', chunk => relayTraffic(runtime, 'in', chunk.length)); upstream.on('data', chunk => relayTraffic(runtime, 'out', chunk.length));
    client.on('error', error => { runtime.lastError = error.message; close(); }); upstream.on('error', error => { runtime.lastError = error.message; close(); }); client.on('close', close); upstream.on('close', close); client.pipe(upstream); upstream.pipe(client);
  });
  runtime.servers.push(server); return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.listen(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
function closeUdpClients(clients, runtime) {
  const count = clients.size;
  for (const entry of clients.values()) { if (entry?.timer) clearTimeout(entry.timer); try { (entry?.socket || entry).close(); } catch {} }
  clients.clear();
  if (runtime) runtime.connections = Math.max(0, runtime.connections - count);
}
function createUdpRelay(rule, runtime) {
  const server = dgram.createSocket('udp4'); const clients = new Map(); const idleMs = 2 * 60 * 1000; runtime.servers.push(server); runtime.udpClients = clients;
  server.on('message', (message, remote) => {
    relayTraffic(runtime, 'in', message.length); const key = `${remote.address}:${remote.port}`; let entry = clients.get(key);
    if (!entry) {
      const socket = dgram.createSocket('udp4'); entry = { socket, timer: null, connected: false, pending: [] };
      const closeEntry = () => { if (entry.timer) clearTimeout(entry.timer); if (clients.get(key) === entry) { clients.delete(key); runtime.connections = Math.max(0, runtime.connections - 1); } try { socket.close(); } catch {} };
      const refresh = () => { if (entry.timer) clearTimeout(entry.timer); entry.timer = setTimeout(closeEntry, idleMs); entry.timer.unref?.(); };
      const send = packet => { if (clients.get(key) !== entry) return; socket.send(packet, error => { if (error) { runtime.lastError = error.message; closeEntry(); } }); };
      entry.refresh = refresh; entry.send = send; socket.on('message', reply => { relayTraffic(runtime, 'out', reply.length); server.send(reply, remote.port, remote.address, error => { if (error) runtime.lastError = error.message; }); refresh(); }); socket.on('error', error => { runtime.lastError = error.message; closeEntry(); }); clients.set(key, entry); runtime.connections++;
      try { socket.connect(rule.targetPort, rule.targetHost, () => { if (clients.get(key) !== entry) return; entry.connected = true; const pending = entry.pending.splice(0); for (const packet of pending) send(packet); refresh(); }); }
      catch (error) { runtime.lastError = error.message; closeEntry(); return; }
    }
    entry.refresh();
    if (entry.connected) entry.send(message);
    else if (entry.pending.length < 32) entry.pending.push(Buffer.from(message));
    else runtime.lastError = `UDP 会话 ${key} 等待目标连接时数据包过多`;
  });
  return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.bind(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
function closeRelayServer(server) { return new Promise(resolve => { try { server.close(resolve); } catch { resolve(); } }); }
async function closeRelayRuntime(runtime) {
  for (const socket of runtime.sockets) try { socket.destroy(); } catch {}
  runtime.sockets.clear(); closeUdpClients(runtime.udpClients, runtime);
  const servers = runtime.servers.splice(0); await Promise.allSettled(servers.map(closeRelayServer)); runtime.connections = 0;
}
async function startRelay(rule) {
  if (!Number.isInteger(rule.listenPort) || !validText(rule.targetHost) || !Number.isInteger(rule.targetPort)) throw new Error('请填写有效监听端口、目标地址和目标端口');
  if (readStore(inboundFile, seedInbounds, normalizeInbound).some(inbound => !inbound.agentId && inbound.status === 'running' && inbound.port === rule.listenPort)) throw new Error('监听端口与本机已启用入站冲突');
  if (relayRuntimes.has(rule.id)) return relaySnapshot(rule);
  const runtime = { status: 'starting', servers: [], sockets: new Set(), udpClients: new Map(), bytesIn: 0, bytesOut: 0, connections: 0, lastError: '' }; relayRuntimes.set(rule.id, runtime);
  try { if (rule.transport === 'tcp' || rule.transport === 'tcp+udp') await createTcpRelay(rule, runtime); if (rule.transport === 'udp' || rule.transport === 'tcp+udp') await createUdpRelay(rule, runtime); runtime.status = 'running'; return relaySnapshot(rule); }
  catch (error) { await closeRelayRuntime(runtime); relayRuntimes.delete(rule.id); throw error; }
}
async function stopRelay(id) { const runtime = relayRuntimes.get(id); if (!runtime) return; runtime.status = 'stopping'; await closeRelayRuntime(runtime); if (relayRuntimes.get(id) === runtime) relayRuntimes.delete(id); }
function createRelay(data) {
  const agentId = cleanText(data.agentId, '', 80); const listenPort = Number(data.listenPort); const targetPort = Number(data.targetPort); const transport = cleanText(data.transport, 'tcp', 16);
  if (!validText(data.name) || !validText(data.targetHost) || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535 || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || !['tcp', 'udp', 'tcp+udp'].includes(transport)) return null;
  return { id: id(), name: data.name.trim(), transport, listenPort, bindAddress: cleanText(data.bindAddress, '0.0.0.0', 80), agentId, targetHost: data.targetHost.trim(), targetPort, entry: cleanText(data.entry, '入口端口', 80), exit: cleanText(data.exit, '目标服务', 80), status: 'running', runtimeStatus: 'stopped', lastError: '', bytesIn: 0, bytesOut: 0, connections: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function updateRelay(existing, data) { const candidate = createRelay({ ...existing, ...data }); return candidate ? { ...candidate, id: existing.id, status: existing.status, createdAt: existing.createdAt, updatedAt: new Date().toISOString() } : null; }
function relayPortConflict(relays, candidate, ignoredId = null) { const usesTcp = mode => mode === 'tcp' || mode === 'tcp+udp'; const usesUdp = mode => mode === 'udp' || mode === 'tcp+udp'; return relays.some(item => item.id !== ignoredId && (item.agentId || '') === candidate.agentId && item.listenPort === candidate.listenPort && ((usesTcp(item.transport) && usesTcp(candidate.transport)) || (usesUdp(item.transport) && usesUdp(candidate.transport)))); }
function executionPortConflicts(inbounds, relays, agentId, port, ignored = {}) {
  const scope = String(agentId || ''); const targetPort = Number(port);
  return {
    inbound: inbounds.some(item => item.id !== ignored.inboundId && String(item.agentId || '') === scope && Number(item.port) === targetPort),
    relay: relays.some(item => item.id !== ignored.relayId && String(item.agentId || '') === scope && Number(item.listenPort) === targetPort)
  };
}
async function activateRelayRule(relay) { if (relay.agentId) { relay.runtimeStatus = 'starting'; relay.lastError = ''; return; } try { const snapshot = await startRelay(relay); Object.assign(relay, snapshot, { status: 'running', lastError: '' }); } catch (error) { relay.status = 'stopped'; relay.runtimeStatus = 'error'; relay.lastError = error.message || '监听端口失败'; } }
function persistRelayState(relay, expectedUpdatedAt = relay.updatedAt) {
  const relays = readStore(relayFile, seedRelays, normalizeRelay); const index = relays.findIndex(item => item.id === relay.id);
  if (index < 0 || relays[index].updatedAt !== expectedUpdatedAt) return false;
  Object.assign(relays[index], { status: relay.status, runtimeStatus: relay.runtimeStatus, lastError: relay.lastError || '', bytesIn: Number(relay.bytesIn || 0), bytesOut: Number(relay.bytesOut || 0), connections: Number(relay.connections || 0) });
  writeStore(relayFile, relays); return true;
}
async function handleAuth(req, res, pathname) {
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const session = currentSession(req); const settings = readSettings();
    return json(res, 200, { authenticated: Boolean(session), username: session?.username || '', mustChangePassword: Boolean(session && settings.admin.mustChangePassword) });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const remote = clientAddress(req); let now = Date.now(); pruneLoginAttempts(now); let attempt = loginAttempts.get(remote);
    if (attempt && attempt.until > now) { auditEvent({ actor: 'anonymous', action: 'auth.login', resource: '/api/auth/login', outcome: 'blocked', status: 429, ip: remote }); return json(res, 429, { error: '登录尝试过多，请 15 分钟后再试' }); }
    const data = await body(req);
    now = Date.now(); pruneLoginAttempts(now); attempt = loginAttempts.get(remote);
    if (attempt && attempt.until > now) { auditEvent({ actor: 'anonymous', action: 'auth.login', resource: '/api/auth/login', outcome: 'blocked', status: 429, ip: remote }); return json(res, 429, { error: '登录尝试过多，请 15 分钟后再试' }); }
    const settings = readSettings();
    const valid = cleanText(data.username, '', 64) === settings.admin.username && typeof data.password === 'string' && crypto.timingSafeEqual(Buffer.from(passwordHash(data.password, settings.admin.salt).hash), Buffer.from(settings.admin.hash));
    if (!valid) {
      const current = loginAttempts.get(remote); const inWindow = current && now - current.startedAt < 15 * 60 * 1000;
      const count = (inWindow ? current.count : 0) + 1; const startedAt = inWindow ? current.startedAt : now;
      loginAttempts.set(remote, { count, startedAt, until: count >= 5 ? now + 15 * 60 * 1000 : 0 });
      auditEvent({ actor: cleanText(data.username, 'unknown', 64), action: 'auth.login', resource: '/api/auth/login', outcome: 'denied', status: 401, ip: remote });
      return json(res, 401, { error: '用户名或密码错误' });
    }
    loginAttempts.delete(remote); auditEvent({ actor: settings.admin.username, action: 'auth.login', resource: '/api/auth/login', outcome: 'success', status: 200, ip: clientAddress(req) });
    const value = token(32); sessions.set(value, { username: settings.admin.username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return json(res, 200, { ok: true, mustChangePassword: settings.admin.mustChangePassword, transportWarning: process.env.SECURE_COOKIE === 'true' && !requestIsSecure(req) ? '当前访问不是受信任的 HTTPS，请使用 HTTPS 反向代理访问面板。' : '' }, { 'Set-Cookie': sessionCookie(req, value, 8 * 60 * 60) });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = currentSession(req); if (session) { auditEvent({ actor: session.username, action: 'auth.logout', resource: '/api/auth/logout', outcome: 'success', status: 200, ip: clientAddress(req) }); sessions.delete(session.token); }
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  return false;
}
async function diagnoseRelay(relay) {
  const checks = []; const add = (name, status, detail) => checks.push({ name, status, detail }); const state = relaySnapshot(relay);
  add('规则配置', relay.listenPort && relay.targetHost && relay.targetPort ? 'ok' : 'error', relay.listenPort ? `${relay.transport.toUpperCase()} ${relay.bindAddress}:${relay.listenPort} → ${relay.targetHost}:${relay.targetPort}` : '规则缺少监听端口或目标地址');
  if (relay.agentId) {
    const agent = readAgents().find(item => item.id === relay.agentId); const online = agent && agentStatus(agent) === 'online';
    add('执行 Agent', online ? 'ok' : 'error', online ? `${agent.name} 在线，最近心跳 ${agent.lastSeenAt}` : 'Agent 离线、已停用或不存在');
    add('远程规则状态', state.runtimeStatus === 'running' ? 'ok' : (state.runtimeStatus === 'starting' ? 'warning' : 'error'), state.runtimeStatus === 'running' ? 'Agent 已确认监听' : (state.lastError || '等待 Agent 下次心跳确认'));
    add('网络放行', 'warning', `请在 ${agent?.name || '目标 Agent'} 的云安全组和防火墙放行 ${relay.transport.toUpperCase()} ${relay.listenPort}`);
    return { ok: checks.every(item => item.status !== 'error'), checks };
  }
  const running = state.runtimeStatus === 'running'; add('本机监听', running ? 'ok' : 'error', running ? `${relay.bindAddress}:${relay.listenPort} 已由面板接管` : (state.lastError || '规则未运行'));
  if (relay.transport === 'tcp' || relay.transport === 'tcp+udp') { const target = await tcpReachable(relay.targetHost, relay.targetPort); add('目标 TCP 可达性', target.ok ? 'ok' : 'warning', target.ok ? `${relay.targetHost}:${relay.targetPort} 可连接` : `${relay.targetHost}:${relay.targetPort} 不可连接：${target.message}`); }
  if (relay.transport === 'udp' || relay.transport === 'tcp+udp') add('UDP 目标检查', 'warning', 'UDP 无通用握手，已确认规则已监听；请结合业务端协议或客户端请求验证回包。');
  add('网络放行', 'warning', `请在云安全组和系统防火墙放行 ${relay.transport.toUpperCase()} ${relay.listenPort}`);
  return { ok: checks.every(item => item.status !== 'error'), checks };
}
async function handleRelays(req, res, parts) {
  const relayId = Number(parts[2]);
  if (parts.length === 2 && req.method === 'GET') {
    const agentsById = new Map(readAgents().map(agent => [agent.id, agent]));
    return json(res, 200, readStore(relayFile, seedRelays, normalizeRelay).map(rule => relaySnapshot(rule, { agentsById })));
  }
  if (parts.length === 2 && req.method === 'POST') {
    const relay = createRelay(await body(req)); if (!relay) return json(res, 400, { error: '请填写规则名称、协议、监听端口与目标地址' }); const agents = readAgents();
    if (relay.agentId && !agents.some(agent => agent.id === relay.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' }); const relays = readStore(relayFile, seedRelays, normalizeRelay); const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound);
    const conflicts = executionPortConflicts(inbounds, relays, relay.agentId, relay.listenPort); if (conflicts.inbound) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' });
    if (relayPortConflict(relays, relay)) return json(res, 409, { error: '该执行节点上监听端口与现有规则的传输协议冲突' }); relays.unshift(relay); writeStore(relayFile, relays); await activateRelayRule(relay); if (!persistRelayState(relay) && !relay.agentId) await stopRelay(relay.id); return json(res, 201, relaySnapshot(relay));
  }
  if (!Number.isInteger(relayId)) return json(res, 404, { error: 'Not found' });
  if (parts.length === 4 && parts[3] === 'diagnose' && req.method === 'POST') { const relay = readStore(relayFile, seedRelays, normalizeRelay).find(item => item.id === relayId); if (!relay) return json(res, 404, { error: 'Not found' }); return json(res, 200, await diagnoseRelay(relay)); }
  if (req.method === 'PATCH') {
    const data = await body(req); const relays = readStore(relayFile, seedRelays, normalizeRelay); const index = relays.findIndex(item => item.id === relayId); if (index < 0) return json(res, 404, { error: 'Not found' }); const relay = relays[index];
    if (Object.keys(data).length === 1 && Object.prototype.hasOwnProperty.call(data, 'status')) {
      if (!statuses.has(data.status)) return json(res, 400, { error: '状态无效' });
      if (data.status === 'running') { const conflicts = executionPortConflicts(readStore(inboundFile, seedInbounds, normalizeInbound), relays, relay.agentId, relay.listenPort, { relayId }); if (conflicts.inbound) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' }); if (relayPortConflict(relays, relay, relayId)) return json(res, 409, { error: '该执行节点上监听端口与现有规则的传输协议冲突' }); }
      if (relay.agentId) {
        const executor = readAgents().find(agent => agent.id === relay.agentId);
        if (data.status === 'running' && (!executor || !executor.enabled)) return json(res, 409, { error: '执行 Agent 不存在或已停用，请先恢复 Agent 后再启用中转', relay: relaySnapshot(relay) });
        if (data.status === 'stopped' && agentWorkloadsStopConfirmed(executor)) { clearRemoteRelayControl(relay); relay.status = 'stopped'; relay.runtimeStatus = 'stopped'; relay.lastError = ''; relay.updatedAt = new Date().toISOString(); writeStore(relayFile, relays); return json(res, 200, relaySnapshot(relay)); }
        if (data.status === 'stopped') requestRemoteRelayControl(relay, 'stop');
        else { clearRemoteRelayControl(relay); relay.status = 'running'; relay.runtimeStatus = 'starting'; relay.lastError = ''; relay.updatedAt = new Date().toISOString(); }
        writeStore(relayFile, relays);
        return json(res, data.status === 'stopped' ? 202 : 200, relaySnapshot(relay));
      }
      relay.status = data.status; relay.updatedAt = new Date().toISOString();
      if (data.status === 'stopped') { await stopRelay(relay.id); relay.runtimeStatus = 'stopped'; relay.lastError = ''; }
      writeStore(relayFile, relays);
      if (data.status === 'running') { await activateRelayRule(relay); if (!persistRelayState(relay)) await stopRelay(relay.id); }
      return json(res, 200, relaySnapshot(relay));
    }
    if (relay.pendingRemoteAction) return json(res, 409, { error: '远程规则正在等待 Agent 确认停止或删除，请稍后再编辑', relay: relaySnapshot(relay) });
    const updated = updateRelay(relay, data); if (!updated) return json(res, 400, { error: '规则名称、协议、监听端口与目标地址必须有效' }); const agents = readAgents();
    if (updated.agentId && !agents.some(agent => agent.id === updated.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' }); const conflicts = executionPortConflicts(readStore(inboundFile, seedInbounds, normalizeInbound), relays, updated.agentId, updated.listenPort, { relayId }); if (conflicts.inbound) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' }); if (relayPortConflict(relays, updated, relayId)) return json(res, 409, { error: '该执行节点上监听端口与现有规则的传输协议冲突' });
    const oldLocal = !relay.agentId; const nextLocalRunning = !updated.agentId && updated.status === 'running';
    if (oldLocal) await stopRelay(relay.id);
    if (nextLocalRunning) {
      try { const snapshot = await startRelay(updated); Object.assign(updated, snapshot, { runtimeStatus: 'running', lastError: '' }); }
      catch (error) {
        let rollbackError = '';
        if (oldLocal && relay.status === 'running') {
          try { const restored = await startRelay(relay); Object.assign(relay, restored, { runtimeStatus: 'running', lastError: '' }); }
          catch (restoreError) { rollbackError = restoreError.message || '原规则恢复失败'; relay.runtimeStatus = 'error'; relay.lastError = `新配置启动失败：${error.message || error}；原规则恢复失败：${rollbackError}`; }
        }
        relays[index] = relay; writeStore(relayFile, relays);
        const rolledBack = !rollbackError && oldLocal && relay.status === 'running';
        return json(res, 409, { error: rolledBack ? `新配置启动失败，已恢复原规则：${error.message || error}` : `新配置启动失败${rollbackError ? `，且原规则恢复失败：${rollbackError}` : ''}：${error.message || error}`, rolledBack, relay: relaySnapshot(relay) });
      }
    }
    relays[index] = updated; writeStore(relayFile, relays); return json(res, 200, relaySnapshot(updated));
  }
  if (req.method === 'DELETE') {
    const relays = readStore(relayFile, seedRelays, normalizeRelay);
    const relay = relays.find(item => item.id === relayId);
    if (!relay) return json(res, 404, { error: 'Not found' });
    if (relay.agentId) {
      const executor = readAgents().find(agent => agent.id === relay.agentId);
      if (agentWorkloadsStopConfirmed(executor)) { writeStore(relayFile, relays.filter(item => item.id !== relayId)); return json(res, 204); }
      requestRemoteRelayControl(relay, 'delete');
      writeStore(relayFile, relays);
      return json(res, 202, { pending: true, relay: relaySnapshot(relay) });
    }
    await stopRelay(relayId);
    writeStore(relayFile, relays.filter(item => item.id !== relayId));
    return json(res, 204);
  }
  return json(res, 405, { error: 'Method not allowed' });
}async function handleInbounds(req, res, parts) {
  const inboundId = Number(parts[2]);
  if (parts.length === 4 && parts[3] === 'qr' && req.method === 'GET' && Number.isInteger(inboundId)) {
    const inbound = readStore(inboundFile, seedInbounds, normalizeInbound).find(item => item.id === inboundId); if (!inbound) return json(res, 404, { error: 'Not found' });
    const svg = await QRCode.toString(inbound.shareLink, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 280, color: { dark: '#202030', light: '#ffffffff' } }); res.writeHead(200, { ...securityHeaders, 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(svg);
  }
  if (parts.length === 4 && parts[3] === 'diagnose' && req.method === 'POST' && Number.isInteger(inboundId)) {
    const inbound = readStore(inboundFile, seedInbounds, normalizeInbound).find(item => item.id === inboundId); if (!inbound) return json(res, 404, { error: 'Not found' });
    const data = await body(req); const report = await diagnoseInbound(inbound, data.repair === true); return json(res, 200, report);
  }
  if (parts.length === 2 && req.method === 'GET') {
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const agentsById = new Map(readAgents().map(agent => [agent.id, agent])); const requestRuntime = runtimeInfo();
    return json(res, 200, inbounds.map(inbound => inboundSnapshot(inbound, { agentsById, runtime: requestRuntime })));
  }
  if (parts.length === 3 && parts[2] === 'import-3xui' && req.method === 'POST') {
    let inbound; try { inbound = import3xuiInbound(await body(req)); } catch (error) { return json(res, 400, { error: error.message }); }
    const agents = readAgents(); if (inbound.agentId && !agents.some(agent => agent.id === inbound.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' }); const tlsError = inboundTlsError(inbound); if (inbound.status === 'running' && tlsError) return json(res, 400, { error: tlsError });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const relays = readStore(relayFile, seedRelays, normalizeRelay); const conflicts = executionPortConflicts(inbounds, relays, inbound.agentId, inbound.port);
    if (conflicts.inbound) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' });
    if (conflicts.relay) return json(res, 409, { error: '该执行节点的监听端口已被中转规则占用' });
    inbounds.unshift(inbound); writeStore(inboundFile, inbounds); if (!inbound.agentId && inbound.status === 'running') await ensureLocalRuntime(); return json(res, 201, inboundSnapshot(inbound));
  }
  if (parts.length === 2 && req.method === 'POST') {
    const inbound = buildNode(await body(req)); if (!inbound) return json(res, 400, { error: '节点名称、地址和端口必须有效' }); const agents = readAgents(); if (inbound.agentId && !agents.some(agent => agent.id === inbound.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' }); const tlsError = inboundTlsError(inbound); if (inbound.status === 'running' && tlsError) return json(res, 400, { error: tlsError });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const relays = readStore(relayFile, seedRelays, normalizeRelay); const conflicts = executionPortConflicts(inbounds, relays, inbound.agentId, inbound.port); if (conflicts.inbound) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' }); if (conflicts.relay) return json(res, 409, { error: '该执行节点的监听端口已被中转规则占用' });
    inbounds.unshift(inbound); writeStore(inboundFile, inbounds); if (!inbound.agentId) await ensureLocalRuntime(); return json(res, 201, inboundSnapshot(inbound));
  }
  if (!Number.isInteger(inboundId)) return json(res, 404, { error: 'Not found' });
  if (req.method === 'PATCH') {
    const data = await body(req); const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const index = inbounds.findIndex(item => item.id === inboundId); if (index < 0) return json(res, 404, { error: 'Not found' }); const inbound = inbounds[index];
    if (Object.prototype.hasOwnProperty.call(data, 'status') && Object.keys(data).length === 1) { if (!statuses.has(data.status)) return json(res, 400, { error: '状态无效' }); const tlsError = data.status === 'running' ? inboundTlsError(inbound) : ''; if (tlsError) return json(res, 400, { error: tlsError }); if (data.status === 'running') { const conflicts = executionPortConflicts(inbounds, readStore(relayFile, seedRelays, normalizeRelay), inbound.agentId, inbound.port, { inboundId }); if (conflicts.inbound) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' }); if (conflicts.relay) return json(res, 409, { error: '该执行节点的监听端口已被中转规则占用' }); } inbound.status = data.status; writeStore(inboundFile, inbounds); if (!inbound.agentId) { if (inbound.status === 'running') await ensureLocalRuntime(); else await syncRuntimeIfRunning(); } return json(res, 200, inboundSnapshot(inbound)); }
    let updated; try { updated = updateInbound(inbound, data); } catch (error) { return json(res, 400, { error: error.message }); } if (!updated) return json(res, 400, { error: '节点名称、地址和端口必须有效' }); const tlsError = inboundTlsError(updated); if (updated.status === 'running' && tlsError) return json(res, 400, { error: tlsError });
    const agents = readAgents(); if (updated.agentId && !agents.some(agent => agent.id === updated.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' });
    const relays = readStore(relayFile, seedRelays, normalizeRelay); const conflicts = executionPortConflicts(inbounds, relays, updated.agentId, updated.port, { inboundId }); if (conflicts.inbound) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' }); if (conflicts.relay) return json(res, 409, { error: '该执行节点的监听端口已被中转规则占用' });
    inbounds[index] = updated; writeStore(inboundFile, inbounds); refreshUserAccessLinks(updated); if (!inbound.agentId || !updated.agentId) { if (!updated.agentId && updated.status === 'running') await ensureLocalRuntime(); else await syncRuntimeIfRunning(); } return json(res, 200, inboundSnapshot(updated));
  }
  if (req.method === 'DELETE') { const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const inbound = inbounds.find(item => item.id === inboundId); if (!inbound) return json(res, 404, { error: 'Not found' }); const assignedUsers = readStore(userFile, seedUsers).filter(user => (user.access || []).some(access => access.inboundId === inboundId)); if (assignedUsers.length) return json(res, 409, { error: '该入站仍分配给 ' + assignedUsers.length + ' 个用户，请先删除或迁移这些用户' }); writeStore(inboundFile, inbounds.filter(item => item.id !== inboundId)); if (!inbound.agentId) await syncRuntimeIfRunning(); return json(res, 204); }
  return json(res, 405, { error: 'Method not allowed' });
}async function handleUsers(req, res, parts) {
  const userId = Number(parts[2]);
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, readStore(userFile, seedUsers));
  if (parts.length === 2 && req.method === 'POST') {
    const data = await body(req); const user = createUser(data); if (!user) return json(res, 400, { error: '请填写有效的用户名称、邮箱和配额' });
    const users = readStore(userFile, seedUsers); if (users.some(item => item.email.toLowerCase() === user.email)) return json(res, 409, { error: '该邮箱已存在' });
    const inboundId = Number(data.inboundId); let syncUserRuntime = null;
    if (data.inboundId && !Number.isInteger(inboundId)) return json(res, 400, { error: '入站选择无效' });
    if (inboundId) {
      const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const inbound = inbounds.find(item => item.id === inboundId);
      if (!inbound) return json(res, 404, { error: '选定的入站不存在' });
      if (inbound.status !== 'running') return json(res, 400, { error: '\u9009\u5b9a\u7684\u5165\u7ad9\u5df2\u6682\u505c\uff0c\u4e0d\u80fd\u5206\u914d\u7528\u6237' }); const tlsError = inboundTlsError(inbound); if (tlsError) return json(res, 400, { error: tlsError }); const access = userAccessForInbound(inbound, user); if (!access) return json(res, 400, { error: '该入站协议暂不支持用户分配' });
      user.access = [access]; setAccessActive(inbound, access, true); writeStore(inboundFile, inbounds); syncUserRuntime = () => !inbound.agentId && inbound.status === 'running' ? ensureLocalRuntime() : syncRuntimeIfRunning();
    }
    users.unshift(user); writeStore(userFile, users); if (syncUserRuntime) await syncUserRuntime(); return json(res, 201, user);
  }
  if (!Number.isInteger(userId)) return json(res, 404, { error: 'Not found' });
  if (req.method === 'PATCH') {
    const data = await body(req); const users = readStore(userFile, seedUsers); const user = users.find(item => item.id === userId); if (!user) return json(res, 404, { error: 'Not found' });
    const expire = data.expire === undefined ? user.expire : normalizeExpire(data.expire); if (expire === null) return json(res, 400, { error: '到期日期格式无效，请使用 YYYY-MM-DD' });
    if (data.status !== undefined && !statuses.has(data.status)) return json(res, 400, { error: '状态无效' });
    let limitGB = Number(user.limitGB);
    if (data.limitGB !== undefined) { const limit = Number(data.limitGB); if (!Number.isFinite(limit) || limit <= 0) return json(res, 400, { error: '配额无效' }); limitGB = Math.round(limit * 1000) / 1000; }
    const expired = userExpired({ expire }); const quotaReached = Number.isFinite(limitGB) && Number(user.usedGB || 0) >= limitGB;
    if (data.status === 'running' && expired) return json(res, 400, { error: '到期用户不能重新启用，请先设置未来的到期日期' });
    if (data.status === 'running' && quotaReached) return json(res, 400, { error: '用户流量已达到配额，请先提高配额后再启用' });
    const previousStatus = user.status; user.expire = expire; user.limitGB = limitGB;
    if (data.status !== undefined) user.status = data.status;
    if (expired || quotaReached) user.status = 'stopped';
    writeStore(userFile, users);
    if (data.status !== undefined || expired || quotaReached || user.status !== previousStatus) { const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); for (const access of user.access || []) setAccessActive(inbounds.find(item => item.id === access.inboundId), access, user.status === 'running'); writeStore(inboundFile, inbounds); const localEnabled = user.status === 'running' && (user.access || []).some(access => { const inbound = inbounds.find(item => item.id === access.inboundId); return inbound && !inbound.agentId && inbound.status === 'running'; }); if (localEnabled) await ensureLocalRuntime(); else await syncRuntimeIfRunning(); }
    return json(res, 200, user);
  }
  if (req.method === 'DELETE') {
    const users = readStore(userFile, seedUsers); const user = users.find(item => item.id === userId); if (!user) return json(res, 404, { error: 'Not found' });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); for (const access of user.access || []) setAccessActive(inbounds.find(item => item.id === access.inboundId), access, false);
    writeStore(inboundFile, inbounds); writeStore(userFile, users.filter(item => item.id !== userId)); await syncRuntimeIfRunning();
    return json(res, 204);
  }
  return json(res, 405, { error: 'Method not allowed' });
}function dateKey(value = new Date()) {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function trafficReport() {
  const users = readStore(userFile, seedUsers); const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const records = readStore(trafficFile, []);
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(); day.setDate(day.getDate() - (6 - index)); return dateKey(day); });
  const daily = days.map(day => ({ day, gb: records.filter(item => dateKey(item.at) === day).reduce((sum, item) => sum + Number(item.gb || 0), 0) }));
  const inboundUsage = inbounds.map(inbound => ({ id: inbound.id, name: inbound.name, protocol: inbound.protocol, gb: records.filter(item => item.inboundId === inbound.id).reduce((sum, item) => sum + Number(item.gb || 0), 0) })).sort((a, b) => b.gb - a.gb);
  return { summary: { totalGB: users.reduce((sum, user) => sum + Number(user.usedGB || 0), 0), recordedGB: records.reduce((sum, item) => sum + Number(item.gb || 0), 0), activeUsers: users.filter(user => user.status === 'running').length, totalRecords: records.length }, daily, users: users.map(user => ({ id: user.id, name: user.name, email: user.email, usedGB: Number(user.usedGB || 0), limitGB: Number(user.limitGB || 0), status: user.status })).sort((a, b) => b.usedGB - a.usedGB), inbounds: inboundUsage, records: records.slice(0, 20) };
}
async function handleTraffic(req, res, parts) {
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, trafficReport());
  if (parts.length === 3 && parts[2] === 'record' && req.method === 'POST') {
    const data = await body(req); const userId = Number(data.userId); const gb = Number(data.gb); const direction = data.direction === 'upload' ? 'upload' : data.direction === 'download' ? 'download' : '';
    if (!Number.isInteger(userId) || !Number.isFinite(gb) || gb <= 0 || gb > 10000 || !direction) return json(res, 400, { error: '用户、方向和流量数值无效' });
    const users = readStore(userFile, seedUsers); const user = users.find(item => item.id === userId); if (!user) return json(res, 404, { error: '用户不存在' }); if (user.status !== 'running') return json(res, 400, { error: '已暂停用户不能记录流量' });
    const inboundId = Number(data.inboundId); const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const inbound = inboundId ? inbounds.find(item => item.id === inboundId) : null;
    if (inboundId && !inbound) return json(res, 404, { error: '入站不存在' });
    user.usedGB = Math.round((Number(user.usedGB || 0) + gb) * 1000) / 1000;
    const limitGB = Number(user.limitGB); const reachedLimit = Number.isFinite(limitGB) && user.usedGB >= limitGB;
    if (reachedLimit) { user.status = 'stopped'; for (const access of user.access || []) setAccessActive(inbounds.find(item => item.id === access.inboundId), access, false); writeStore(inboundFile, inbounds); }
    writeStore(userFile, users); if (reachedLimit) await syncRuntimeIfRunning();
    const records = readStore(trafficFile, []); const record = { id: id(), userId: user.id, userName: user.name, inboundId: inbound?.id || null, inboundName: inbound?.name || '未指定入站', gb: Math.round(gb * 1000) / 1000, direction, at: new Date().toISOString(), source: 'manual' };
    records.unshift(record); writeStore(trafficFile, records.slice(0, 5000));
    return json(res, 201, { record, user, reachedLimit });
  }
  return json(res, 405, { error: 'Method not allowed' });
}function domainValid(domain) { return typeof domain === 'string' && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain.trim()); }
function validateTlsFiles(certPath, keyPath) {
  try {
    if (!certPath || !keyPath || !fs.existsSync(certPath) || !fs.existsSync(keyPath)) return { error: '证书或私钥文件不存在或不可读' };
    const cert = fs.readFileSync(certPath); const key = fs.readFileSync(keyPath); tls.createSecureContext({ cert, key });
    return { cert, key };
  } catch (error) { return { error: `证书或私钥无效/不匹配：${(error.message || String(error)).slice(0, 300)}` }; }
}
function tlsPublic(settings) {
  const tls = settings.tls; const configured = Boolean(tls.certPath && tls.keyPath); const validation = configured ? validateTlsFiles(tls.certPath, tls.keyPath) : { error: '' }; const ready = configured && !validation.error;
  return { ...tls, ready, restartRequired: ready, error: validation.error || '' };
}
function certbotExists() { return spawnSync(process.platform === 'win32' ? 'where' : 'which', ['certbot'], { encoding: 'utf8' }).status === 0; }
function certificateRequestError(result, domain) {
  const raw = String(result?.stderr || result?.stdout || result?.error?.message || '未知错误').replace(/\s+/g, ' ').trim().slice(0, 600);
  let hint = `Let's Encrypt HTTP-01 验证失败。请确认：1) ${domain} 的 A/AAAA 记录已指向这台 VPS；2) 云安全组和系统防火墙已放行 TCP 80；3) 80 端口未被 Nginx、Apache 或其他程序占用。`;
  if (/address already in use|could not bind|bind to port 80/i.test(raw)) hint += ' 当前提示表明 80 端口可能被占用；请停止占用程序后重试，或改用已正确配置 challenge 路径的反向代理。';
  else if (/timeout|connection refused|no route|challenge failed/i.test(raw)) hint += ' 验证服务器无法从公网访问该域名的 80 端口；请检查 DNS 生效、云防火墙和运营商端口限制。';
  else if (/unauthorized|invalid response|not found/i.test(raw)) hint += ' 验证响应不正确；请检查域名解析是否指向当前服务器，以及是否有 CDN/反向代理改写了 HTTP 请求。';
  return `${hint}\n\ncertbot 摘要：${raw}`;
}
function xrayCommand() { const local = path.join(root, 'runtime', process.platform === 'win32' ? 'xray.exe' : 'xray'); return fs.existsSync(local) ? local : cleanText(process.env.XRAY_BIN, process.platform === 'win32' ? 'xray.exe' : 'xray', 512); }
function xrayProbe() {
  const binary = xrayCommand(); const result = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.error || result.status !== 0) return { available: false, binary, version: '', error: result.error?.code === 'ENOENT' ? '未检测到 Xray Core' : (result.stderr || result.error?.message || 'Xray Core 不可用').slice(0, 240) };
  const version = (result.stdout || result.stderr || '').split(/\r?\n/)[0].trim(); const match = version.match(/Xray\s+([0-9]+(?:\.[0-9]+)+)/); return { available: true, binary, version, installedVersion: match ? `v${match[1]}` : '', error: '' };
}
function runtimeConfig() {
  const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound).filter(item => item.status === 'running' && !item.agentId && !inboundTlsError(item)).map(item => { const config = JSON.parse(JSON.stringify(item.xray)); if (config.listen === '') delete config.listen; return config; });
  return { log: { loglevel: 'warning' }, inbounds, outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'blocked' }] };
}
function runtimeInfo() {
  const probe = xrayProbe(); const running = Boolean(runtime.child && runtime.child.exitCode === null && !runtime.child.killed);
  return { ...probe, running, pid: running ? runtime.child.pid : null, startedAt: running ? runtime.startedAt : '', lastError: runtime.lastError, lastLog: runtime.lastLog, installing: runtime.installing, enabledInbounds: runtimeConfig().inbounds.length };
}
function appendRuntimeLog(value) { runtime.lastLog = `${runtime.lastLog}${String(value || '')}`.slice(-1500); }
function startRuntime() {
  const probe = xrayProbe(); if (!probe.available) return { error: probe.error };
  if (runtime.child && runtime.child.exitCode === null) return runtime.child.killed ? { error: 'Xray Core 正在停止，请稍后重试' } : { info: runtimeInfo() };
  const config = runtimeConfig(); const validation = validateRuntimeConfig(config); if (!validation.ok) { runtime.lastError = validation.error; return { error: validation.error }; }
  writeStore(runtimeFile, config); runtime.lastError = ''; runtime.lastLog = '';
  const child = spawn(probe.binary, ['run', '-c', runtimeFile], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); runtime.child = child; runtime.startedAt = new Date().toISOString();
  child.stdout.on('data', appendRuntimeLog); child.stderr.on('data', appendRuntimeLog);
  child.on('error', error => { if (runtime.child === child) runtime.lastError = error.message; });
  child.on('exit', (code, signal) => { if (runtime.child !== child) return; if (code && code !== 0) runtime.lastError = `Xray 已退出（code ${code}${signal ? `, ${signal}` : ''}）`; runtime.child = null; });
  return { info: runtimeInfo() };
}
function stopRuntime() {
  const child = runtime.child; if (!child || child.exitCode !== null) return false;
  if (child.killed) return true;
  try { return child.kill(); } catch (error) { runtime.lastError = error.message || 'Xray Core 停止请求失败'; return false; }
}
function validateRuntimeConfig(config) {
  const probe = xrayProbe(); if (!probe.available) return { ok: true, skipped: true };
  const file = path.join(root, `.runtime-check-${id()}.json`);
  try { fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); const result = spawnSync(probe.binary, ['run', '-test', '-c', file], { encoding: 'utf8', windowsHide: true, timeout: 15000 }); return result.status === 0 ? { ok: true } : { ok: false, error: (result.stderr || result.stdout || 'Xray 配置校验失败').slice(-900) }; }
  catch (error) { return { ok: false, error: error.message || 'Xray 配置校验失败' }; }
  finally { try { fs.unlinkSync(file); } catch {} }
}
function waitForExit(child, timeout = 3000) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false; const finish = exited => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('close', onExit); resolve(exited); }; const onExit = () => finish(true); const timer = setTimeout(() => finish(false), timeout); child.once('exit', onExit); child.once('close', onExit);
  });
}
function queueRuntimeOperation(operation) {
  const next = runtimeOperationTail.then(operation, operation); runtimeOperationTail = next.catch(() => {}); return next;
}
async function stopRuntimeAndWait() {
  const child = runtime.child; if (!child || child.exitCode !== null) return { stopped: false };
  if (!stopRuntime()) {
    if (child.exitCode !== null || runtime.child !== child || await waitForExit(child, 100)) return { stopped: true };
    runtime.lastError = runtime.lastError || 'Xray Core 停止请求失败'; return { error: runtime.lastError };
  }
  let exited = await waitForExit(child);
  if (!exited) {
    try { child.kill('SIGKILL'); } catch {}
    exited = await waitForExit(child, 1000);
  }
  if (!exited) { runtime.lastError = 'Xray Core 未能在强制停止后退出'; return { error: runtime.lastError }; }
  return { stopped: true };
}
async function ensureLocalRuntimeNow() {
  const info = runtimeInfo(); if (!info.available) return { error: info.error || '未检测到 Xray Core' };
  if (info.running) return syncRuntimeIfRunningNow();
  const started = startRuntime(); if (started.error) return { error: started.error };
  await new Promise(resolve => setTimeout(resolve, 450)); const current = runtimeInfo();
  return current.running ? { started: true } : { error: current.lastError || 'Xray Core 启动失败，请查看系统日志' };
}
async function syncRuntimeIfRunningNow() {
  const active = Boolean(runtime.child && runtime.child.exitCode === null); if (!active) return { reloaded: false };
  const config = runtimeConfig(); const check = validateRuntimeConfig(config); if (!check.ok || check.skipped) { runtime.lastError = `新配置未应用：${check.error || 'Xray Core 不可用，无法校验配置'}`; return { error: runtime.lastError }; }
  const stopped = await stopRuntimeAndWait(); if (stopped.error) { runtime.lastError = `${stopped.error}，新配置未应用`; return { error: runtime.lastError }; } const started = startRuntime(); if (started.error) { runtime.lastError = started.error; return { error: started.error }; }
  await new Promise(resolve => setTimeout(resolve, 350)); if (!runtime.child || runtime.child.exitCode !== null || runtime.child.killed) return { error: runtime.lastError || 'Xray 重载后未保持运行' };
  runtime.lastLog = `配置已自动重载\n${runtime.lastLog}`.slice(-1500); return { reloaded: true };
}
function ensureLocalRuntime() { return queueRuntimeOperation(ensureLocalRuntimeNow); }
function syncRuntimeIfRunning() { return queueRuntimeOperation(syncRuntimeIfRunningNow); }
function startLocalRuntime() { return queueRuntimeOperation(() => startRuntime()); }
function stopLocalRuntime() { return queueRuntimeOperation(async () => { const result = await stopRuntimeAndWait(); return result.error ? result : { ...result, info: runtimeInfo() }; }); }
function networkInfo() { return { ...networkState }; }
function requestPublicIp(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': '3xUI-Lite-Network-Check', Accept: 'application/json,text/plain' } }, response => {
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`HTTP ${response.statusCode}`)); }
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('公网地址检测超时'))); request.on('error', reject);
  });
}
async function detectPublicAddress(force = false) {
  if (networkState.checking) return networkInfo();
  if (!force && networkState.publicAddress && Date.now() - Date.parse(networkState.checkedAt || 0) < 30 * 60 * 1000) return networkInfo();
  networkState.checking = true; networkState.error = '';
  const configured = cleanText(process.env.PUBLIC_ADDRESS, '', 255);
  if (configured && net.isIP(configured)) { Object.assign(networkState, { publicAddress: configured, source: 'PUBLIC_ADDRESS', checkedAt: new Date().toISOString(), checking: false }); return networkInfo(); }
  const sources = [{ url: 'https://api64.ipify.org?format=json', name: 'api64.ipify.org', json: true }, { url: 'https://api.ipify.org', name: 'api.ipify.org', json: false }];
  for (const source of sources) {
    try { const response = await requestPublicIp(source.url); const address = (source.json ? JSON.parse(response).ip : response).trim(); if (net.isIP(address)) { Object.assign(networkState, { publicAddress: address, source: source.name, checkedAt: new Date().toISOString(), error: '', checking: false }); return networkInfo(); } } catch (error) { networkState.error = error.message || '公网地址检测失败'; }
  }
  networkState.checkedAt = new Date().toISOString(); networkState.checking = false; return networkInfo();
}function requestBuffer(url, redirects = 0, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('下载重定向次数过多'));
    let settled = false; let headerTimer; let request;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(headerTimer);
      if (error) reject(error); else resolve(value);
    };
    request = https.get(url, { headers: { 'User-Agent': '3xUI-Lite-Core-Installer', Accept: 'application/vnd.github+json' } }, response => {
      clearTimeout(headerTimer);
      response.setTimeout(timeoutMs, () => {
        const error = new Error('下载响应超时'); response.destroy(error); request.destroy(error); finish(error);
      });
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); return finish(null, requestBuffer(new URL(response.headers.location, url).toString(), redirects + 1, timeoutMs));
      }
      if (response.statusCode !== 200) { response.resume(); return finish(new Error(`下载失败（HTTP ${response.statusCode}）`)); }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 120 * 1024 * 1024) {
          const error = new Error('下载文件过大'); response.destroy(error); request.destroy(error); finish(error);
        } else chunks.push(chunk);
      });
      response.on('end', () => finish(null, Buffer.concat(chunks)));
      response.on('aborted', () => finish(new Error('下载响应被中断')));
      response.on('error', error => finish(error));
    });
    headerTimer = setTimeout(() => {
      const error = new Error('下载连接超时'); request.destroy(error); finish(error);
    }, timeoutMs);
    request.on('error', error => finish(error));
  });
}
function xrayReleaseAsset() {
  if (process.platform === 'win32' && process.arch === 'x64') return { archive: 'Xray-windows-64.zip', binary: 'xray.exe' };
  if (process.platform === 'linux' && process.arch === 'x64') return { archive: 'Xray-linux-64.zip', binary: 'xray' };
  if (process.platform === 'linux' && process.arch === 'arm64') return { archive: 'Xray-linux-arm64-v8a.zip', binary: 'xray' };
  if (process.platform === 'linux' && process.arch === 'arm') return { archive: 'Xray-linux-arm32-v7a.zip', binary: 'xray' };
  return null;
}
function publishRuntimeFiles(sourceDir, targetDir, binaryName) {
  fs.mkdirSync(targetDir, { recursive: true });
  const releaseId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const entries = [binaryName, 'geoip.dat', 'geosite.dat'].map(name => {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`安装包中未找到 ${name}`);
    const extension = path.extname(name); const stem = extension ? name.slice(0, -extension.length) : name;
    return { name, source, destination: path.join(targetDir, name), next: path.join(targetDir, `.${stem}.${releaseId}.next${extension}`), backup: path.join(targetDir, `.${stem}.${releaseId}.previous${extension}`), backedUp: false, published: false };
  });
  try {
    for (const entry of entries) {
      fs.copyFileSync(entry.source, entry.next);
      if (entry.name === binaryName && process.platform !== 'win32') fs.chmodSync(entry.next, 0o755);
    }
    const stagedBinary = entries.find(entry => entry.name === binaryName).next;
    const verify = spawnSync(stagedBinary, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (verify.error || verify.status !== 0) throw new Error(`${binaryName} 发布前校验失败`);
    for (const entry of entries) {
      if (fs.existsSync(entry.destination)) { fs.renameSync(entry.destination, entry.backup); entry.backedUp = true; }
      fs.renameSync(entry.next, entry.destination); entry.published = true;
    }
  } catch (error) {
    let rollbackError = '';
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.published && fs.existsSync(entry.destination)) fs.unlinkSync(entry.destination);
        if (entry.backedUp && fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.destination);
      } catch (rollback) { rollbackError ||= rollback.message || String(rollback); }
    }
    for (const entry of entries) try { if (fs.existsSync(entry.next)) fs.unlinkSync(entry.next); } catch {}
    if (rollbackError) throw new Error(`${error.message || error}；回滚失败：${rollbackError}`);
    throw error;
  }
  for (const entry of entries) {
    try { if (fs.existsSync(entry.backup)) fs.unlinkSync(entry.backup); } catch {}
    try { if (fs.existsSync(entry.next)) fs.unlinkSync(entry.next); } catch {}
  }
}
async function installXrayNow() {
  if (runtime.installing) return { error: 'Xray Core 正在安装中' };
  if (runtime.child && runtime.child.exitCode === null) return { error: '请先等待 Xray Core 完全停止' };
  const rawVersion = cleanText(arguments[0], '', 80); const requestedVersion = rawVersion && !rawVersion.startsWith('v') ? `v${rawVersion}` : rawVersion;
  if (requestedVersion && !/^v[0-9]+(?:\.[0-9]+){1,3}(?:[-._a-zA-Z0-9]+)?$/.test(requestedVersion)) return { error: '版本格式无效，请使用官方标签，例如 v26.3.27' };
  const targetAsset = xrayReleaseAsset(); if (!targetAsset) return { error: `当前系统不支持内置安装：${process.platform} ${process.arch}` };
  runtime.installing = true; runtime.lastError = '';
  const temp = fs.mkdtempSync(path.join(root, '.xray-install-'));
  try {
    const releaseUrl = requestedVersion ? `https://api.github.com/repos/XTLS/Xray-core/releases/tags/${encodeURIComponent(requestedVersion)}` : 'https://api.github.com/repos/XTLS/Xray-core/releases/latest';
    const release = JSON.parse((await requestBuffer(releaseUrl)).toString('utf8'));
    const asset = release.assets?.find(item => item.name === targetAsset.archive); const digest = release.assets?.find(item => item.name === `${targetAsset.archive}.dgst`);
    if (!asset || !digest) throw new Error(`官方发布页未找到 ${targetAsset.archive} 或其 SHA-256 校验文件`);
    const zip = await requestBuffer(asset.browser_download_url); const digestText = (await requestBuffer(digest.browser_download_url)).toString('utf8'); const expected = digestText.match(/SHA2-256\s*=\s*([a-fA-F0-9]{64})/)?.[1]?.toLowerCase(); const actual = crypto.createHash('sha256').update(zip).digest('hex');
    if (!expected || expected !== actual) throw new Error('安装包 SHA-256 校验失败，已拒绝安装');
    const zipFile = path.join(temp, 'xray.zip'); const out = path.join(temp, 'out'); fs.writeFileSync(zipFile, zip); fs.mkdirSync(out);
    const unpack = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zipFile, out], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
      : spawnSync('unzip', ['-oq', zipFile, '-d', out], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (unpack.error?.code === 'ENOENT') throw new Error(process.platform === 'win32' ? '未找到 PowerShell，无法解压 Xray 安装包' : '未找到 unzip；请运行面板更新脚本安装依赖后重试');
    if (unpack.status !== 0) throw new Error(`解压失败：${(unpack.stderr || unpack.stdout || '未知错误').slice(0, 300)}`);
    const source = path.join(out, targetAsset.binary); if (!fs.existsSync(source)) throw new Error(`安装包中未找到 ${targetAsset.binary}`);
    if (process.platform !== 'win32') fs.chmodSync(source, 0o755);
    const verify = spawnSync(source, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); if (verify.status !== 0) throw new Error(`${targetAsset.binary} 校验失败`);
    const target = path.join(root, 'runtime'); publishRuntimeFiles(out, target, targetAsset.binary);
    runtime.lastLog = `已安装 Xray Core ${release.tag_name || ''}`; return { info: runtimeInfo(), version: release.tag_name || '' };
  } catch (error) { runtime.lastError = error.message || 'Xray Core 安装失败'; return { error: runtime.lastError }; }
  finally { runtime.installing = false; fs.rmSync(temp, { recursive: true, force: true }); }
}
function installLocalRuntime(version) {
  if (runtime.installing || runtimeInstallQueued) return Promise.resolve({ error: 'Xray Core 正在安装中' });
  runtimeInstallQueued = true;
  return queueRuntimeOperation(async () => {
    if (runtime.child && runtime.child.exitCode === null) return { error: '请先停止正在运行的 Xray Core' };
    return installXrayNow(version);
  }).finally(() => { runtimeInstallQueued = false; });
}
async function handleRuntime(req, res, parts) {
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, runtimeInfo());
  if (parts.length === 3 && parts[2] === 'config' && req.method === 'GET') return json(res, 200, runtimeConfig());
  if (parts.length === 3 && parts[2] === 'install' && req.method === 'POST') { const data = await body(req); const result = await installLocalRuntime(data.version); return result.error ? json(res, 422, { error: result.error, runtime: runtimeInfo() }) : json(res, 201, result); }
  if (parts.length === 3 && parts[2] === 'start' && req.method === 'POST') { const result = await startLocalRuntime(); return result.error ? json(res, 409, { error: result.error, runtime: runtimeInfo() }) : json(res, 200, result.info); }
  if (parts.length === 3 && parts[2] === 'stop' && req.method === 'POST') { const result = await stopLocalRuntime(); return result.error ? json(res, 409, { error: result.error, runtime: runtimeInfo() }) : json(res, 200, result.info); }
  return json(res, 405, { error: 'Method not allowed' });
}async function handleSystem(req, res, pathname) {
  if (pathname === '/api/system' && req.method === 'GET') { const settings = readSettings(); return json(res, 200, { panelVersion: PANEL_VERSION, admin: { username: settings.admin.username, mustChangePassword: settings.admin.mustChangePassword }, tls: tlsPublic(settings), certbotAvailable: certbotExists(), runtime: runtimeInfo(), network: networkInfo(), security: { transportSecure: requestIsSecure(req), secureCookie: process.env.SECURE_COOKIE === 'true' || requestIsSecure(req), trustProxy: process.env.TRUST_PROXY === 'true', defaultPassword: settings.admin.defaultPassword === true, mustChangePassword: settings.admin.mustChangePassword === true, auditEntries: readAudit(1000).length } }); }
  if (pathname === '/api/system/audit' && req.method === 'GET') return json(res, 200, { entries: readAudit(200) });
  if (pathname === '/api/system/backup' && req.method === 'GET') { auditOnFinish(req, res, currentSession(req), 'admin.backup.export', pathname); const backup = createBackup(); const date = new Date().toISOString().slice(0, 10); return json(res, 200, backup, { 'Content-Disposition': 'attachment; filename=3xui-lite-backup-' + date + '.json' }); }
  if (pathname === '/api/system/network' && req.method === 'GET') return json(res, 200, networkInfo());
  if (pathname === '/api/system/network/detect' && req.method === 'POST') return json(res, 200, await detectPublicAddress(true));  if (pathname === '/api/system/password' && req.method === 'POST') {
    const data = await body(req); const settings = readSettings(); const candidate = typeof data.currentPassword === 'string' ? passwordHash(data.currentPassword, settings.admin.salt).hash : '';
    if (!candidate || !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(settings.admin.hash))) return json(res, 400, { error: '当前密码不正确' });
    if (typeof data.newPassword !== 'string' || data.newPassword.length < 10 || data.newPassword.length > 128) return json(res, 400, { error: '新密码需为 10–128 个字符' });
    if (data.newPassword === data.currentPassword) return json(res, 400, { error: '新密码不能与当前密码相同' });
    Object.assign(settings.admin, passwordHash(data.newPassword), { mustChangePassword: false, defaultPassword: false, defaultPasswordChecked: true }); writeSettings(settings); sessions.clear();
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  if (pathname === '/api/system/tls' && req.method === 'POST') {
    const data = await body(req); const settings = readSettings(); const domain = cleanText(data.domain, '', 253).toLowerCase(); const email = cleanText(data.email, '', 100); const certPath = cleanText(data.certPath, '', 512); const keyPath = cleanText(data.keyPath, '', 512);
    if (!domainValid(domain) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '请填写有效域名和通知邮箱' });
    if (Boolean(certPath) !== Boolean(keyPath)) return json(res, 400, { error: '证书和私钥路径必须同时填写' });
    if (certPath) { const validation = validateTlsFiles(certPath, keyPath); if (validation.error) return json(res, 400, { error: validation.error }); }
    settings.tls = { domain, email, certPath, keyPath, updatedAt: new Date().toISOString() }; writeSettings(settings);
    return json(res, 200, { tls: tlsPublic(settings) });
  }
  if (pathname === '/api/system/tls/request' && req.method === 'POST') {
    const data = await body(req); const settings = readSettings(); const domain = cleanText(data.domain, '', 253).toLowerCase(); const email = cleanText(data.email, '', 100);
    if (!domainValid(domain) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '请填写有效域名和通知邮箱' });
    if (!certbotExists()) return json(res, 409, { error: '未检测到 certbot。请在服务器安装 certbot 后重试：apt install certbot（Debian/Ubuntu）。' });
    const result = spawnSync('certbot', ['certonly', '--standalone', '--preferred-challenges', 'http', '--http-01-port', '80', '-d', domain, '--email', email, '--agree-tos', '--non-interactive', '--keep-until-expiring'], { encoding: 'utf8', timeout: 180000 });
    if (result.error || result.status !== 0) return json(res, 422, { error: certificateRequestError(result, domain) });
    settings.tls = { domain, email, certPath: `/etc/letsencrypt/live/${domain}/fullchain.pem`, keyPath: `/etc/letsencrypt/live/${domain}/privkey.pem`, updatedAt: new Date().toISOString() }; writeSettings(settings);
    return json(res, 200, { tls: tlsPublic(settings), message: '证书已申请。请应用到 TLS 入站并重启面板 HTTPS 服务。' });
  }
  if (pathname === '/api/system/tls/apply' && req.method === 'POST') {
    const settings = readSettings(); if (!settings.tls.certPath || !settings.tls.keyPath || !fs.existsSync(settings.tls.certPath) || !fs.existsSync(settings.tls.keyPath)) return json(res, 400, { error: '证书文件不可用，请先保存正确路径或申请证书' });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); let changed = 0;
    for (const inbound of inbounds) if (!inbound.agentId && inbound.streamSettings?.security === 'tls') { inbound.streamSettings.tlsSettings = { ...(inbound.streamSettings.tlsSettings || {}), certificates: [{ certificateFile: settings.tls.certPath, keyFile: settings.tls.keyPath }] }; inbound.xray.streamSettings = inbound.streamSettings; changed++; }
    writeStore(inboundFile, inbounds); if (inbounds.some(inbound => inbound.status === 'running' && !inbound.agentId)) await ensureLocalRuntime(); else await syncRuntimeIfRunning(); return json(res, 200, { changed, message: `已将证书写入 ${changed} 个本机 TLS 入站（VLESS、WebSocket、gRPC 与 Trojan）。远程 Agent 请填写其本机证书路径。` });
  }
  return json(res, 405, { error: 'Method not allowed' });
}
async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost'); const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api' && parts[1] !== 'agent' && !requestOriginAllowed(req)) return json(res, 403, { error: '请求来源校验失败', code: 'ORIGIN_REJECTED' });
    if (url.pathname.startsWith('/api/auth/')) { const handled = await handleAuth(req, res, url.pathname); if (handled !== false) return; return json(res, 404, { error: 'Not found' }); }
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, version: PANEL_VERSION });
    if (parts[0] === 'api' && parts[1] === 'agent') return await handleAgentGateway(req, res, parts);
    if (parts[0] === 'api') {
      const session = requireAuth(req, res); if (!session) return;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) auditOnFinish(req, res, session, 'admin.request', url.pathname);
      const settings = readSettings(); if (settings.admin.mustChangePassword && url.pathname !== '/api/system/password') return json(res, 403, { error: '首次使用必须先修改一次性初始密码', code: 'PASSWORD_CHANGE_REQUIRED' });
      await reconcileExpiredUsers();
      if (parts[1] === 'relays') return await handleRelays(req, res, parts);
      if (parts[1] === 'agents') return await handleAgents(req, res, parts);
      if (parts[1] === 'inbounds') return await handleInbounds(req, res, parts);
      if (parts[1] === 'users') return await handleUsers(req, res, parts);
      if (parts[1] === 'traffic') return await handleTraffic(req, res, parts);
      if (parts[1] === 'runtime') return await handleRuntime(req, res, parts);
      if (parts[1] === 'system') return await handleSystem(req, res, url.pathname);
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const file = path.resolve(root, requested);
    if (!file.startsWith(root + path.sep) || !publicFiles.has(requested) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Not found' });
    const stream = fs.createReadStream(file); stream.on('error', error => { console.error(`Static file read failed: ${error.message || error}`); res.destroy(error); });
    res.writeHead(200, { ...securityHeaders, 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); stream.pipe(res);
  } catch (error) {
    if (res.headersSent) { res.destroy(error); return; }
    const statusCode = error?.code === 'ERR_INVALID_URL' || error instanceof SyntaxError ? 400 : Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (statusCode >= 500) console.error(`Request failed: ${error.message || error}`);
    json(res, statusCode, { error: statusCode >= 500 ? '服务器处理请求失败，请查看服务日志' : (error.message || '请求无效') });
  }
}
const server = http.createServer(requestHandler);
if (require.main === module) {
  const panelHost = process.env.PANEL_HOST || '0.0.0.0';
  server.listen(port, panelHost, () => {
    console.log('3xUI Lite HTTP: http://' + panelHost + ':' + port);
    for (const relay of readStore(relayFile, seedRelays, normalizeRelay)) if (relay.status === 'running' && relay.listenPort && !relay.agentId) {
      const expectedUpdatedAt = relay.updatedAt;
      startRelay(relay).then(snapshot => { Object.assign(relay, snapshot, { runtimeStatus: 'running', lastError: '' }); persistRelayState(relay, expectedUpdatedAt); }).catch(error => { relay.runtimeStatus = 'error'; relay.lastError = `启动监听失败：${error.message || error}`; persistRelayState(relay, expectedUpdatedAt); console.error(`Relay ${relay.name} failed: ${error.message}`); });
    }
    if (runtimeConfig().inbounds.length) { const started = startRuntime(); if (started.error) { runtime.lastError = started.error; console.error(`Xray startup failed: ${started.error}`); } }
    reconcileExpiredUsers().catch(error => console.error(`User expiration reconciliation failed: ${error.message}`));
    setInterval(() => reconcileExpiredUsers().catch(error => console.error(`User expiration reconciliation failed: ${error.message}`)), 60 * 1000).unref();
    setInterval(() => { const now = Date.now(); for (const [value, session] of sessions) if (session.expiresAt <= now) sessions.delete(value); }, 15 * 60 * 1000).unref();
  });
  const bootTls = readSettings().tls; announceInitialAdminPassword();
  if (bootTls.certPath && bootTls.keyPath) {
    const httpsPort = Number(process.env.HTTPS_PORT || 3443);
    try {
      const credentials = validateTlsFiles(bootTls.certPath, bootTls.keyPath);
      if (credentials.error) throw new Error(credentials.error);
      const tlsServer = https.createServer({ cert: credentials.cert, key: credentials.key }, requestHandler);
      tlsServer.on('error', error => console.error(`3xUI Lite HTTPS 启动失败，HTTP 面板仍可用于修复：${error.message || error}`));
      tlsServer.listen(httpsPort, panelHost, () => console.log(`3xUI Lite HTTPS: https://${panelHost}:${httpsPort}`));
    } catch (error) { console.error(`3xUI Lite HTTPS 配置无效，HTTP 面板仍可用于修复：${error.message || error}`); }
  }
}
module.exports = { server, buildNode, import3xuiInbound, createUser, normalizeExpire, userExpired, inboundTlsError, agentInstallScript, readSettings, certificateRequestError };
