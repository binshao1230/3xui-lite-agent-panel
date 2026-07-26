'use strict';
const http = require('node:http');
const https = require('node:https');
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
const port = Number(process.env.PORT || 3000);
const sessions = new Map();
const loginAttempts = new Map();
const runtime = { child: null, startedAt: '', lastError: '', lastLog: '', installing: false };
const networkState = { publicAddress: '', source: '', checkedAt: '', error: '', checking: false };
const relayRuntimes = new Map();
const privateFiles = new Set(['settings.json', 'users.json', 'inbounds.json', 'relays.json', 'traffic.json', 'agents.json', 'runtime-xray.json']);

const seedRelays = [];
const protocolMap = { 'VLESS + Reality': 'vless-reality', VLESS: 'vless', 'VLESS + TLS': 'vless-tls', 'VLESS + WebSocket': 'vless-ws', 'VLESS + gRPC': 'vless-grpc', 'Trojan + TLS': 'trojan-tls', Shadowsocks: 'shadowsocks' };
const protocolLabels = Object.fromEntries(Object.entries(protocolMap).map(([label, value]) => [value, label]));
const templateNames = { 'vless-reality': 'VLESS Reality 模板', vless: '纯 VLESS TCP 模板', 'vless-tls': 'VLESS TLS 模板', 'vless-ws': 'VLESS WebSocket + TLS 模板', 'vless-grpc': 'VLESS gRPC + TLS 模板', 'trojan-tls': 'Trojan TLS 模板', shadowsocks: 'Shadowsocks 2022 模板' };
const protocols = new Set(Object.keys(protocolMap));
const statuses = new Set(['running', 'stopped']);
const ss2022Methods = new Set(['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const seedUsers = [];

function token(bytes = 16) { return crypto.randomBytes(bytes).toString('base64url'); }
function id() { return Date.now() + Math.floor(Math.random() * 1000); }
function passwordHash(password, salt = token(16)) { return { salt, hash: crypto.scryptSync(password, salt, 64).toString('base64') }; }
function defaultSettings() {
  return { admin: { username: 'admin', ...passwordHash('admin'), mustChangePassword: true }, tls: { domain: '', email: '', certPath: '', keyPath: '', updatedAt: '' } };
}
function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingFile, 'utf8'));
    if (data?.admin?.salt && data?.admin?.hash) return { admin: { username: 'admin', mustChangePassword: false, ...data.admin }, tls: { domain: '', email: '', certPath: '', keyPath: '', updatedAt: '', ...data.tls } };
  } catch {}
  const settings = defaultSettings();
  writeSettings(settings);
  return settings;
}
function writeSettings(settings) { fs.writeFileSync(settingFile, JSON.stringify(settings, null, 2)); }
function readStore(file, fallback, normalizer) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? (normalizer ? data.map(normalizer) : data) : fallback.map(item => ({ ...item }));
  } catch { return fallback.map(item => ({ ...item })); }
}
function writeStore(file, items) { fs.writeFileSync(file, JSON.stringify(items, null, 2)); }
function removeLegacyDemoData() {
  const remove = (file, predicate) => {
    try {
      const items = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(items)) return;
      const kept = items.filter(item => !predicate(item));
      if (kept.length !== items.length) writeStore(file, kept);
    } catch {}
  };
  remove(relayFile, item => ['Tokyo BGP', 'Hong Kong Express', 'Frankfurt Backup'].includes(item?.name));
  remove(inboundFile, item => ['VLESS Reality Demo', 'Trojan TLS Demo', 'Shadowsocks Demo'].includes(item?.name));
  remove(userFile, item => ['demo@example.com', 'trial@example.com'].includes(String(item?.email || '').toLowerCase()));
  remove(trafficFile, item => [201, 202].includes(Number(item?.userId)));
}
removeLegacyDemoData();
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
  try { const items = JSON.parse(fs.readFileSync(inboundFile, 'utf8')); if (!Array.isArray(items)) return; if (items.some(alignInboundWith3xui)) writeStore(inboundFile, items); } catch {}
}
migrateInboundCompatibility();
function json(res, code, payload, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(code === 204 ? '' : JSON.stringify(payload));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function validText(value, max = 128) { return typeof value === 'string' && value.trim().length > 0 && value.length < max; }
function cleanText(value, fallback = '', max = 128) { return validText(value, max) ? value.trim() : fallback; }
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('=');
    return index < 0 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
  }));
}
function currentSession(req) {
  const value = parseCookies(req).session;
  const session = value && sessions.get(value);
  if (!session || session.expiresAt < Date.now()) { if (value) sessions.delete(value); return null; }
  return { token: value, ...session };
}
function sessionCookie(value, seconds = 0) {
  const secure = process.env.SECURE_COOKIE === 'true' ? '; Secure' : '';
  return `session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
}
function requireAuth(req, res) {
  if (currentSession(req)) return true;
  json(res, 401, { error: '请先登录管理员账号' });
  return false;
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
  const fingerprint = cleanText(input.fingerprint, 'chrome'); const flow = cleanText(input.flow, 'xtls-rprx-vision'); const email = cleanText(input.email, `client-${nodeId}`);
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
function vlessTlsSettings(sni) { const tlsSettings = { serverName: sni, minVersion: '1.2' }; const certificate = activeTlsSettings(); if (certificate) tlsSettings.certificates = [certificate]; return tlsSettings; }
function makeVlessTls(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const email = cleanText(input.email, `client-${nodeId}`); const sni = cleanText(input.sni, input.serverAddress);
  const settings = { clients: [{ id: clientId, email }], decryption: 'none', fallbacks: [] }; const streamSettings = { network: 'tcp', security: 'tls', tcpSettings: { header: { type: 'none' } }, tlsSettings: vlessTlsSettings(sni) };
  return finishInbound(input, nodeId, status, 'vless', 'TLS', settings, streamSettings, `vless://${clientId}@${input.serverAddress}:${input.port}?type=tcp&encryption=none&security=tls&sni=${encodeURIComponent(sni)}#${shareName(input.name)}`);
}
function makeVlessWs(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const email = cleanText(input.email, `client-${nodeId}`); const sni = cleanText(input.sni, input.serverAddress); const wsPath = cleanText(input.path, '/vless', 180); const host = cleanText(input.host, sni, 180);
  const settings = { clients: [{ id: clientId, email }], decryption: 'none', fallbacks: [] }; const streamSettings = { network: 'ws', security: 'tls', tlsSettings: vlessTlsSettings(sni), wsSettings: { path: wsPath, headers: { Host: host } } };
  return finishInbound(input, nodeId, status, 'vless', 'WebSocket + TLS', settings, streamSettings, `vless://${clientId}@${input.serverAddress}:${input.port}?type=ws&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&host=${encodeURIComponent(host)}&path=${encodeURIComponent(wsPath)}#${shareName(input.name)}`);
}
function makeVlessGrpc(input, nodeId, status) {
  const clientId = crypto.randomUUID(); const email = cleanText(input.email, `client-${nodeId}`); const sni = cleanText(input.sni, input.serverAddress); const serviceName = cleanText(input.serviceName, 'vless-grpc', 120);
  const settings = { clients: [{ id: clientId, email }], decryption: 'none', fallbacks: [] }; const streamSettings = { network: 'grpc', security: 'tls', tlsSettings: vlessTlsSettings(sni), grpcSettings: { serviceName, multiMode: false } };
  return finishInbound(input, nodeId, status, 'vless', 'gRPC + TLS', settings, streamSettings, `vless://${clientId}@${input.serverAddress}:${input.port}?type=grpc&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&serviceName=${encodeURIComponent(serviceName)}&mode=gun#${shareName(input.name)}`);
}function makeTrojanTls(input, nodeId, status) {
  const password = token(18); const sni = cleanText(input.sni, input.serverAddress); const email = cleanText(input.email, `client-${nodeId}`);
  const tlsSettings = { serverName: sni, minVersion: '1.2' }; const certificate = activeTlsSettings();
  if (certificate) tlsSettings.certificates = [certificate];
  const settings = { clients: [{ password, email }], fallbacks: [] };
  const streamSettings = { network: 'tcp', security: 'tls', tcpSettings: { header: { type: 'none' } }, tlsSettings };
  const shareLink = `trojan://${password}@${input.serverAddress}:${input.port}?security=tls&type=tcp&sni=${encodeURIComponent(sni)}#${shareName(input.name)}`;
  return finishInbound(input, nodeId, status, 'trojan', 'TLS', settings, streamSettings, shareLink);
}
function ss2022Key(method) { return crypto.randomBytes(method === '2022-blake3-aes-128-gcm' ? 16 : 32).toString('base64'); }
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
  const input = { ...data, id: forcedId, agentId: cleanText(data.agentId, '', 80), name: data.name.trim(), protocolKey, protocol: protocolLabel, port: listenPort, serverAddress: data.serverAddress.trim(), remark: cleanText(data.remark, '', 180), sni: cleanText(data.sni, '', 180), dest: cleanText(data.dest, '', 180), fingerprint: cleanText(data.fingerprint, 'chrome'), flow: cleanText(data.flow, 'xtls-rprx-vision'), path: cleanText(data.path, '/vless', 180), host: cleanText(data.host, '', 180), serviceName: cleanText(data.serviceName, 'vless-grpc', 120), method: cleanText(data.method, '2022-blake3-aes-128-gcm'), email: cleanText(data.email, '', 100), templateName: templateNames[protocolKey] };
  if (protocolKey === 'vless') return makeVless(input, forcedId, forcedStatus);
  if (protocolKey === 'vless-tls') return makeVlessTls(input, forcedId, forcedStatus);
  if (protocolKey === 'vless-ws') return makeVlessWs(input, forcedId, forcedStatus);
  if (protocolKey === 'vless-grpc') return makeVlessGrpc(input, forcedId, forcedStatus);
  if (protocolKey === 'trojan-tls') return makeTrojanTls(input, forcedId, forcedStatus);
  if (protocolKey === 'shadowsocks') return makeShadowsocks(input, forcedId, forcedStatus);
  return makeVlessReality(input, forcedId, forcedStatus);
}
function shareLinkForInbound(inbound) {
  const settings = inbound.settings || {}; const stream = inbound.streamSettings || {}; const client = settings.clients?.[0] || {}; const address = inbound.serverAddress; const port = inbound.port;
  if (inbound.protocolCode === 'vless') {
    if (inbound.security === 'Reality') { const reality = stream.realitySettings || {}; const config = reality.settings || {}; const sni = reality.serverNames?.[0] || ''; const sid = reality.shortIds?.[0] || ''; const flow = client.flow || 'xtls-rprx-vision'; return `vless://${client.id}@${address}:${port}?type=tcp&encryption=none&security=reality&pbk=${config.publicKey || ''}&fp=${config.fingerprint || 'chrome'}&sni=${encodeURIComponent(sni)}&sid=${sid}&spx=%2F&flow=${flow}#${shareName(inbound.name)}`; }
    if (stream.security === 'tls') { const sni = stream.tlsSettings?.serverName || address; if (stream.network === 'ws') { const ws = stream.wsSettings || {}; return `vless://${client.id}@${address}:${port}?type=ws&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&host=${encodeURIComponent(ws.headers?.Host || sni)}&path=${encodeURIComponent(ws.path || '/vless')}#${shareName(inbound.name)}`; } if (stream.network === 'grpc') { const serviceName = stream.grpcSettings?.serviceName || 'vless-grpc'; return `vless://${client.id}@${address}:${port}?type=grpc&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&serviceName=${encodeURIComponent(serviceName)}&mode=gun#${shareName(inbound.name)}`; } return `vless://${client.id}@${address}:${port}?type=tcp&encryption=none&security=tls&sni=${encodeURIComponent(sni)}#${shareName(inbound.name)}`; }
    return `vless://${client.id}@${address}:${port}?type=tcp&encryption=none&security=none#${shareName(inbound.name)}`;
  }
  if (inbound.protocolCode === 'trojan') { const sni = stream.tlsSettings?.serverName || address; return `trojan://${client.password}@${address}:${port}?security=tls&type=tcp&sni=${encodeURIComponent(sni)}#${shareName(inbound.name)}`; }
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
    protocolKey = 'trojan-tls'; protocol = 'Trojan + TLS'; security = transportSecurity === 'tls' ? 'TLS' : 'None';
  } else {
    if (!settings.method || !settings.password) throw new Error('Shadowsocks 配置缺少 method 或 password');
    protocolKey = 'shadowsocks'; protocol = 'Shadowsocks'; security = 'SS2022';
  }
  const inbound = {
    id: id(), name: cleanText(data.name || source.remark || source.tag, `${protocol} ${listenPort}`, 120), protocol, protocolCode, template: '3x-ui 兼容导入', port: listenPort, serverAddress,
    security, remark: cleanText(data.remark || source.remark, '', 180), agentId: cleanText(data.agentId, '', 80), status: source.enable === false ? 'stopped' : 'running', settings, streamSettings, sniffing,
    xray: { listen: typeof source.listen === 'string' ? source.listen : '', port: listenPort, protocol: protocolCode, settings, streamSettings, tag: cleanText(source.tag, `inbound-${listenPort}`, 120), sniffing }
  };
  alignInboundWith3xui(inbound); inbound.template = `3x-ui ${protocolLabels[protocolKey] || protocol} 兼容配置`; inbound.shareLink = shareLinkForInbound(inbound);
  if (!inbound.shareLink) throw new Error('导入配置无法生成客户端链接，请确认客户端字段完整');
  return inbound;
}function updateInbound(existing, data) {
  if (data.protocol && data.protocol !== existing.protocol) throw new Error('编辑节点时不能切换协议；请新建节点。');
  const candidate = buildNode({ ...data, protocol: existing.protocol }, existing.id, existing.status);
  if (!candidate) return null;
  candidate.settings = JSON.parse(JSON.stringify(existing.settings || candidate.settings));
  candidate.streamSettings = JSON.parse(JSON.stringify(existing.streamSettings || candidate.streamSettings));
  if (candidate.security === 'Reality') { const generated = buildNode({ ...data, protocol: existing.protocol }, existing.id, existing.status); const oldReality = candidate.streamSettings.realitySettings || {}; const nextReality = generated.streamSettings.realitySettings || {}; oldReality.dest = nextReality.dest; oldReality.serverNames = nextReality.serverNames; oldReality.settings = { ...(oldReality.settings || {}), fingerprint: nextReality.settings?.fingerprint || 'chrome', serverName: nextReality.settings?.serverName || '' }; candidate.streamSettings.realitySettings = oldReality; }
  if (candidate.streamSettings.security === 'tls') { const generated = buildNode({ ...data, protocol: existing.protocol }, existing.id, existing.status); candidate.streamSettings.tlsSettings = { ...(candidate.streamSettings.tlsSettings || {}), serverName: generated.streamSettings.tlsSettings?.serverName || candidate.serverAddress }; if (candidate.streamSettings.network === 'ws') candidate.streamSettings.wsSettings = generated.streamSettings.wsSettings; if (candidate.streamSettings.network === 'grpc') candidate.streamSettings.grpcSettings = generated.streamSettings.grpcSettings; }
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
function userAccessForInbound(inbound, user) {
  const email = user.email;
  if (inbound.protocolCode === 'vless') {
    const client = { id: crypto.randomUUID(), email }; const stream = inbound.streamSettings || {}; let link;
    if (inbound.security === 'Reality') {
      client.flow = inbound.settings.clients?.[0]?.flow || 'xtls-rprx-vision'; const reality = stream.realitySettings || {}; const sni = reality.serverNames?.[0] || ''; const sid = reality.shortIds?.[0] || ''; const config = reality.settings || {};
      link = `vless://${client.id}@${inbound.serverAddress}:${inbound.port}?type=tcp&encryption=none&security=reality&pbk=${config.publicKey || ''}&fp=${config.fingerprint || 'chrome'}&sni=${encodeURIComponent(sni)}&sid=${sid}&spx=%2F&flow=${client.flow}#${shareName(`${inbound.name}-${user.name}`)}`;
    } else if (stream.security === 'tls') {
      const sni = stream.tlsSettings?.serverName || inbound.serverAddress;
      if (stream.network === 'ws') { const ws = stream.wsSettings || {}; const wsPath = ws.path || '/vless'; const host = ws.headers?.Host || sni; link = `vless://${client.id}@${inbound.serverAddress}:${inbound.port}?type=ws&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&host=${encodeURIComponent(host)}&path=${encodeURIComponent(wsPath)}#${shareName(`${inbound.name}-${user.name}`)}`; }
      else if (stream.network === 'grpc') { const serviceName = stream.grpcSettings?.serviceName || 'vless-grpc'; link = `vless://${client.id}@${inbound.serverAddress}:${inbound.port}?type=grpc&encryption=none&security=tls&sni=${encodeURIComponent(sni)}&serviceName=${encodeURIComponent(serviceName)}&mode=gun#${shareName(`${inbound.name}-${user.name}`)}`; }
      else link = `vless://${client.id}@${inbound.serverAddress}:${inbound.port}?type=tcp&encryption=none&security=tls&sni=${encodeURIComponent(sni)}#${shareName(`${inbound.name}-${user.name}`)}`;
    } else link = `vless://${client.id}@${inbound.serverAddress}:${inbound.port}?type=tcp&encryption=none&security=none#${shareName(`${inbound.name}-${user.name}`)}`;
    return { inboundId: inbound.id, protocol: inbound.protocol, protocolCode: inbound.protocolCode, client, link };
  }
  if (inbound.protocolCode === 'trojan') {
    const client = { password: token(18), email }; const sni = inbound.streamSettings.tlsSettings?.serverName || inbound.serverAddress;
    return { inboundId: inbound.id, protocol: inbound.protocol, protocolCode: inbound.protocolCode, client, link: `trojan://${client.password}@${inbound.serverAddress}:${inbound.port}?security=tls&type=tcp&sni=${encodeURIComponent(sni)}#${shareName(`${inbound.name}-${user.name}`)}` };
  }
  if (inbound.protocolCode === 'shadowsocks') {
    const method = inbound.settings.method; const client = { password: ss2022Key(method), email, level: 0 }; const credentials = Buffer.from(`${method}:${inbound.settings.password}:${client.password}`).toString('base64url');
    return { inboundId: inbound.id, protocol: inbound.protocol, protocolCode: inbound.protocolCode, client, link: `ss://${credentials}@${inbound.serverAddress}:${inbound.port}#${shareName(`${inbound.name}-${user.name}`)}` };
  }
  return null;
}function setAccessActive(inbound, access, active) {
  if (!inbound?.settings?.clients || !access?.client) return;
  const key = accessClientKey(inbound.protocolCode); const exists = inbound.settings.clients.some(item => item[key] === access.client[key]);
  if (active && !exists) inbound.settings.clients.push(access.client);
  if (!active && exists) inbound.settings.clients = inbound.settings.clients.filter(item => item[key] !== access.client[key]);
  if (inbound.xray) inbound.xray.settings = inbound.settings;
}function createUser(data) {
  if (!validText(data.name) || !validText(data.email, 100)) return null;
  const email = data.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const limitGB = Number(data.limitGB || 100);
  return { id: id(), name: data.name.trim(), email, limitGB: Number.isFinite(limitGB) && limitGB > 0 ? Math.round(limitGB) : 100, usedGB: 0, expire: cleanText(data.expire, '', 40), status: 'running', createdAt: new Date().toISOString(), access: [] };
}
function controllerUrl(value) {
  try { const url = new URL(String(value || '')); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''; return url.toString().replace(/\/$/, ''); } catch { return ''; }
}
function normalizeAgentInboundStates(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 200).map(item => ({ id: Number(item?.id), status: ['running', 'starting', 'stopped', 'error'].includes(item?.status) ? item.status : 'stopped', lastError: cleanText(item?.lastError, '', 500), updatedAt: cleanText(item?.updatedAt, '', 64) })).filter(item => Number.isInteger(item.id));
}function normalizeAgentRelayStates(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 200).map(item => ({ id: Number(item?.id), status: ['running', 'starting', 'stopped', 'error'].includes(item?.status) ? item.status : 'stopped', lastError: cleanText(item?.lastError, '', 500), bytesIn: Math.max(0, Number(item?.bytesIn || 0)), bytesOut: Math.max(0, Number(item?.bytesOut || 0)), connections: Math.max(0, Number(item?.connections || 0)), updatedAt: cleanText(item?.updatedAt, '', 64) })).filter(item => Number.isInteger(item.id));
}
function normalizeAgent(item) {
  if (!item || typeof item !== 'object' || !validText(item.id, 80) || !validText(item.token, 160)) return null;
  return { id: item.id, token: item.token, name: cleanText(item.name, 'Unnamed Agent', 80), controllerUrl: controllerUrl(item.controllerUrl), enabled: item.enabled !== false, version: cleanText(item.version, '', 60), hostname: cleanText(item.hostname, '', 120), platform: cleanText(item.platform, '', 80), arch: cleanText(item.arch, '', 40), nodeVersion: cleanText(item.nodeVersion, '', 40), uptimeSeconds: Math.max(0, Number(item.uptimeSeconds || 0)), memoryTotal: Math.max(0, Number(item.memoryTotal || 0)), memoryFree: Math.max(0, Number(item.memoryFree || 0)), cpus: Math.max(0, Number(item.cpus || 0)), addresses: Array.isArray(item.addresses) ? item.addresses.filter(value => validText(value, 80)).slice(0, 20) : [], processId: Math.max(0, Number(item.processId || 0)), agentStartedAt: cleanText(item.agentStartedAt, '', 64), updateRequestId: cleanText(item.updateRequestId, '', 64), updateRequestedAt: cleanText(item.updateRequestedAt, '', 64), lastUpdatedAt: cleanText(item.lastUpdatedAt, '', 64), xrayAvailable: item.xrayAvailable === true, xrayVersion: cleanText(item.xrayVersion, '', 100), xrayInstallRequestId: cleanText(item.xrayInstallRequestId, '', 64), xrayInstallRequestedAt: cleanText(item.xrayInstallRequestedAt, '', 64), xrayInstalling: item.xrayInstalling === true, xrayInstallError: cleanText(item.xrayInstallError, '', 500), xrayInstalledAt: cleanText(item.xrayInstalledAt, '', 64), inboundStates: normalizeAgentInboundStates(item.inboundStates), lastSeenAt: cleanText(item.lastSeenAt, '', 64), createdAt: cleanText(item.createdAt, new Date().toISOString(), 64), updatedAt: cleanText(item.updatedAt, '', 64), relayStates: normalizeAgentRelayStates(item.relayStates) };
}function readAgents() { return readStore(agentFile, [], normalizeAgent).filter(Boolean); }
function agentStatus(agent) { if (!agent.enabled) return 'disabled'; const seen = Date.parse(agent.lastSeenAt || ''); return Number.isFinite(seen) && Date.now() - seen < 90 * 1000 ? 'online' : 'offline'; }
function agentPublic(agent) { const { token: hidden, updateRequestId: hiddenUpdate, xrayInstallRequestId: hiddenXrayInstall, ...safe } = agent; return { ...safe, status: agentStatus(agent), updatePending: Boolean(agent.updateRequestId), xrayInstallPending: Boolean(agent.xrayInstallRequestId) }; }
function secureTokenMatch(expected, actual) { if (typeof actual !== 'string' || expected.length !== actual.length) return false; return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual)); }
function agentServiceName(agent) { return `3xui-lite-agent-${agent.id}`; }
function agentInstallScript(agent) {
  const serviceName = agentServiceName(agent); const installDir = `/opt/${serviceName}`; const serviceFile = `/etc/systemd/system/${serviceName}.service`;
  return `#!/usr/bin/env bash
set -euo pipefail
install_dir=${JSON.stringify(installDir)}
service_file=${JSON.stringify(serviceFile)}
mkdir -p "$install_dir"
curl -fsSL ${JSON.stringify(`${agent.controllerUrl}/agent.js`)} -o "$install_dir/agent.js"
cat > "$service_file" <<'UNIT'
[Unit]
Description=3xUI Lite Agent (${agent.name.replace(/[\r\n]/g, ' ')})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${installDir}
ExecStart=/usr/bin/env node ${installDir}/agent.js --controller ${agent.controllerUrl} --id ${agent.id} --token ${agent.token}
Restart=always
RestartSec=5
RestartPreventExitStatus=1
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
chmod 600 "$service_file"
systemctl daemon-reload
systemctl enable --now ${serviceName}
systemctl --no-pager --full status ${serviceName}`;
}
function agentCommand(agent) { return `echo ${Buffer.from(agentInstallScript(agent)).toString('base64')} | base64 -d | sudo bash`; }
function createAgent(data) {
  const name = cleanText(data.name, '', 80); const target = controllerUrl(data.controllerUrl);
  if (!name || !target) return null;
  const now = new Date().toISOString(); return { id: `agent-${token(9)}`, token: token(32), name, controllerUrl: target, enabled: true, version: '', hostname: '', platform: '', arch: '', nodeVersion: '', lastSeenAt: '', createdAt: now, updatedAt: now };
}
function agentInboundTasks(agentId) {
  return readStore(inboundFile, seedInbounds, normalizeInbound).filter(inbound => inbound.agentId === agentId && inbound.status === 'running').map(inbound => ({ id: inbound.id, name: inbound.name, port: inbound.port, xray: inbound.xray }));
}function agentRelayTasks(agentId) {
  return readStore(relayFile, seedRelays, normalizeRelay).filter(rule => rule.agentId === agentId && rule.status === 'running').map(rule => ({ id: rule.id, name: rule.name, transport: rule.transport, listenPort: rule.listenPort, bindAddress: rule.bindAddress, targetHost: rule.targetHost, targetPort: rule.targetPort }));
}
async function handleAgentGateway(req, res, parts) {
  if (parts.length !== 3 || parts[2] !== 'heartbeat' || req.method !== 'POST') return json(res, 404, { error: 'Not found' });
  const data = await body(req); const agentId = cleanText(data.id, '', 80); const supplied = cleanText(data.token, '', 160); const agents = readAgents(); const agent = agents.find(item => item.id === agentId);
  if (!agent || !secureTokenMatch(agent.token, supplied)) return json(res, 401, { error: 'Agent 身份验证失败' });
  if (!agent.enabled) return json(res, 403, { error: '该 Agent 已被面板停用' });
  const info = data.info && typeof data.info === 'object' ? data.info : data;
  if (agent.updateRequestId && cleanText(info.updateAck, '', 64) === agent.updateRequestId) { agent.lastUpdatedAt = new Date().toISOString(); agent.updateRequestId = ''; agent.updateRequestedAt = ''; }
  if (agent.xrayInstallRequestId && cleanText(info.xrayInstallAck, '', 64) === agent.xrayInstallRequestId) { agent.xrayInstalledAt = new Date().toISOString(); agent.xrayInstallRequestId = ''; agent.xrayInstallRequestedAt = ''; agent.xrayInstallError = ''; }
  agent.version = cleanText(info.version, agent.version, 60); agent.hostname = cleanText(info.hostname, agent.hostname, 120); agent.platform = cleanText(info.platform, agent.platform, 80); agent.arch = cleanText(info.arch, agent.arch, 40); agent.nodeVersion = cleanText(info.nodeVersion, agent.nodeVersion, 40); agent.uptimeSeconds = Math.max(0, Number(info.uptimeSeconds || 0)); agent.memoryTotal = Math.max(0, Number(info.memoryTotal || 0)); agent.memoryFree = Math.max(0, Number(info.memoryFree || 0)); agent.cpus = Math.max(0, Number(info.cpus || 0)); agent.addresses = Array.isArray(info.addresses) ? info.addresses.filter(value => validText(value, 80)).slice(0, 20) : []; agent.processId = Math.max(0, Number(info.processId || 0)); agent.agentStartedAt = cleanText(info.agentStartedAt, agent.agentStartedAt, 64); agent.xrayAvailable = info.xrayAvailable === true; agent.xrayVersion = cleanText(info.xrayVersion, agent.xrayVersion, 100); agent.xrayInstalling = info.xrayInstalling === true; agent.xrayInstallError = cleanText(info.xrayInstallError, '', 500); agent.inboundStates = normalizeAgentInboundStates(info.inboundStates); agent.relayStates = normalizeAgentRelayStates(info.relayStates); agent.lastSeenAt = new Date().toISOString(); agent.updatedAt = agent.lastSeenAt;
  writeStore(agentFile, agents); return json(res, 200, { ok: true, intervalSeconds: 15, relays: agentRelayTasks(agent.id), inbounds: agentInboundTasks(agent.id), xrayInstall: agent.xrayInstallRequestId ? { id: agent.xrayInstallRequestId, version: 'latest' } : null, update: agent.updateRequestId ? { id: agent.updateRequestId, url: `${agent.controllerUrl}/agent.js` } : null, agent: agentPublic(agent) });
}async function handleAgents(req, res, parts) {
  const agentId = cleanText(parts[2], '', 80);
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, readAgents().map(agentPublic));
  if (parts.length === 2 && req.method === 'POST') { const agent = createAgent(await body(req)); if (!agent) return json(res, 400, { error: '请填写机器名称和可被远程访问的控制面板地址（HTTP/HTTPS）' }); const agents = readAgents(); agents.unshift(agent); writeStore(agentFile, agents); return json(res, 201, { agent: agentPublic(agent), deployment: { command: agentCommand(agent), controllerUrl: agent.controllerUrl, id: agent.id, token: agent.token } }); }
  const agents = readAgents(); const agent = agents.find(item => item.id === agentId); if (!agent) return json(res, 404, { error: 'Not found' });
  if (parts.length === 5 && parts[3] === 'xray' && parts[4] === 'install' && req.method === 'POST') { agent.xrayInstallRequestId = token(12); agent.xrayInstallRequestedAt = new Date().toISOString(); agent.xrayInstallError = ''; agent.updatedAt = agent.xrayInstallRequestedAt; writeStore(agentFile, agents); return json(res, 202, { agent: agentPublic(agent), message: '已下发 Xray Core 安装任务，等待 Agent 执行。' }); }  if (parts.length === 4 && parts[3] === 'update' && req.method === 'POST') { agent.updateRequestId = token(12); agent.updateRequestedAt = new Date().toISOString(); agent.updatedAt = agent.updateRequestedAt; writeStore(agentFile, agents); return json(res, 202, { agent: agentPublic(agent), message: '已下发更新请求，等待 Agent 心跳执行。' }); }
  if (parts.length === 4 && parts[3] === 'bootstrap' && req.method === 'GET') return json(res, 200, { command: agentCommand(agent), controllerUrl: agent.controllerUrl, id: agent.id, token: agent.token });
  if (req.method === 'PATCH') { const data = await body(req); if (data.enabled !== undefined) agent.enabled = Boolean(data.enabled); if (data.controllerUrl !== undefined) { const target = controllerUrl(data.controllerUrl); if (!target) return json(res, 400, { error: '控制面板地址必须是有效的 HTTP/HTTPS 地址' }); agent.controllerUrl = target; } if (data.name !== undefined) { const name = cleanText(data.name, '', 80); if (!name) return json(res, 400, { error: '机器名称不能为空' }); agent.name = name; } if (data.rotateToken === true) agent.token = token(32); agent.updatedAt = new Date().toISOString(); writeStore(agentFile, agents); return json(res, 200, { agent: agentPublic(agent), deployment: (data.rotateToken === true || data.controllerUrl !== undefined) ? { command: agentCommand(agent), controllerUrl: agent.controllerUrl, id: agent.id, token: agent.token } : undefined }); }
  if (req.method === 'DELETE') { writeStore(agentFile, agents.filter(item => item.id !== agentId)); return json(res, 204); }
  return json(res, 405, { error: 'Method not allowed' });
}function normalizeRelay(item) {
  if (!item || typeof item !== 'object') return item;
  if (Number.isInteger(Number(item.listenPort)) && validText(item.targetHost) && Number.isInteger(Number(item.targetPort))) return { ...item, listenPort: Number(item.listenPort), targetPort: Number(item.targetPort), transport: ['tcp', 'udp', 'tcp+udp'].includes(item.transport) ? item.transport : 'tcp', bindAddress: cleanText(item.bindAddress, '0.0.0.0', 80), agentId: cleanText(item.agentId, '', 80), runtimeStatus: item.runtimeStatus || 'stopped', lastError: item.lastError || '', bytesIn: Number(item.bytesIn || 0), bytesOut: Number(item.bytesOut || 0), connections: Number(item.connections || 0) };
  return { ...item, transport: item.transport || 'tcp', listenPort: null, targetHost: '', targetPort: null, agentId: '', runtimeStatus: 'legacy', lastError: '旧版线路档案：请新建含监听端口与目标地址的转发规则。', bytesIn: 0, bytesOut: 0, connections: 0 };
}
function remoteRelaySnapshot(rule) {
  const agent = readAgents().find(item => item.id === rule.agentId); const agentState = agent?.relayStates?.find(item => item.id === rule.id);
  const status = rule.status !== 'running' ? 'stopped' : !agent ? 'error' : agentStatus(agent) === 'online' ? (agentState?.status || 'starting') : agentStatus(agent);
  return { ...rule, runtimeStatus: status, lastError: status === 'error' ? (agentState?.lastError || '远程 Agent 不存在或规则启动失败') : (agentState?.lastError || ''), bytesIn: Number(agentState?.bytesIn || 0), bytesOut: Number(agentState?.bytesOut || 0), connections: Number(agentState?.connections || 0), agentName: agent?.name || '未知 Agent', agentLastSeenAt: agent?.lastSeenAt || '' };
}function relaySnapshot(rule) {
  if (rule.agentId) return remoteRelaySnapshot(rule);
  const runtime = relayRuntimes.get(rule.id); if (!runtime) return { ...rule, runtimeStatus: rule.runtimeStatus === 'legacy' ? 'legacy' : 'stopped' };
  return { ...rule, runtimeStatus: runtime.status, lastError: runtime.lastError || rule.lastError || '', bytesIn: runtime.bytesIn, bytesOut: runtime.bytesOut, connections: runtime.connections };
}
function inboundSnapshot(inbound) {
  if (!inbound.agentId) {
    if (inbound.status !== 'running') return inbound;
    const info = runtimeInfo();
    if (!info.available) return { ...inbound, status: 'error', desiredStatus: inbound.status, lastError: info.error || '未检测到 Xray Core' };
    if (!info.running) return { ...inbound, status: 'error', desiredStatus: inbound.status, lastError: info.lastError || 'Xray Core 尚未启动' };
    return { ...inbound, lastError: '' };
  }
  const agent = readAgents().find(item => item.id === inbound.agentId); const reported = agent?.inboundStates?.find(item => item.id === inbound.id); const state = inbound.status !== 'running' ? 'stopped' : !agent ? 'error' : agentStatus(agent) === 'online' ? (reported?.status || 'starting') : agentStatus(agent);
  return { ...inbound, status: state, desiredStatus: inbound.status, lastError: state === 'error' ? (reported?.lastError || (agent?.xrayAvailable === false ? 'Agent 未检测到 Xray Core' : '远程节点启动失败')) : (reported?.lastError || ''), agentName: agent?.name || '未知 Agent', agentLastSeenAt: agent?.lastSeenAt || '' };
}function relayTraffic(runtime, direction, size) { if (direction === 'in') runtime.bytesIn += size; else runtime.bytesOut += size; }
function createTcpRelay(rule, runtime) {
  const server = net.createServer(client => {
    runtime.connections++; const upstream = net.connect({ host: rule.targetHost, port: rule.targetPort });
    client.on('data', chunk => relayTraffic(runtime, 'in', chunk.length)); upstream.on('data', chunk => relayTraffic(runtime, 'out', chunk.length));
    client.pipe(upstream); upstream.pipe(client); const close = () => { client.destroy(); upstream.destroy(); }; client.on('error', close); upstream.on('error', close);
  });
  runtime.servers.push(server); return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.listen(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
function createUdpRelay(rule, runtime) {
  const server = dgram.createSocket('udp4'); const clients = new Map(); runtime.servers.push(server); runtime.udpClients = clients;
  server.on('message', (message, remote) => {
    relayTraffic(runtime, 'in', message.length); const key = `${remote.address}:${remote.port}`; let upstream = clients.get(key);
    if (!upstream) { upstream = dgram.createSocket('udp4'); upstream.on('message', reply => { relayTraffic(runtime, 'out', reply.length); server.send(reply, remote.port, remote.address); }); upstream.on('error', error => { runtime.lastError = error.message; }); clients.set(key, upstream); }
    upstream.send(message, rule.targetPort, rule.targetHost);
  });
  return new Promise((resolve, reject) => { const fail = error => reject(error); server.once('error', fail); server.bind(rule.listenPort, rule.bindAddress, () => { server.removeListener('error', fail); server.on('error', error => { runtime.status = 'error'; runtime.lastError = error.message; }); resolve(); }); });
}
async function startRelay(rule) {
  if (!Number.isInteger(rule.listenPort) || !validText(rule.targetHost) || !Number.isInteger(rule.targetPort)) throw new Error('请填写有效监听端口、目标地址和目标端口');
  if (readStore(inboundFile, seedInbounds, normalizeInbound).some(inbound => inbound.status === 'running' && inbound.port === rule.listenPort)) throw new Error('监听端口与已启用入站冲突');
  if (relayRuntimes.has(rule.id)) return relaySnapshot(rule);
  const runtime = { status: 'starting', servers: [], udpClients: new Map(), bytesIn: 0, bytesOut: 0, connections: 0, lastError: '' }; relayRuntimes.set(rule.id, runtime);
  try { if (rule.transport === 'tcp' || rule.transport === 'tcp+udp') await createTcpRelay(rule, runtime); if (rule.transport === 'udp' || rule.transport === 'tcp+udp') await createUdpRelay(rule, runtime); runtime.status = 'running'; return relaySnapshot(rule); }
  catch (error) { for (const server of runtime.servers) try { server.close(); } catch {} for (const client of runtime.udpClients.values()) try { client.close(); } catch {} relayRuntimes.delete(rule.id); throw error; }
}
function stopRelay(id) { const runtime = relayRuntimes.get(id); if (!runtime) return; for (const server of runtime.servers) try { server.close(); } catch {} for (const client of runtime.udpClients.values()) try { client.close(); } catch {} relayRuntimes.delete(id); }
function createRelay(data) {
  const agentId = cleanText(data.agentId, '', 80); const listenPort = Number(data.listenPort); const targetPort = Number(data.targetPort); const transport = cleanText(data.transport, 'tcp', 16);
  if (!validText(data.name) || !validText(data.targetHost) || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535 || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || !['tcp', 'udp', 'tcp+udp'].includes(transport)) return null;
  return { id: id(), name: data.name.trim(), transport, listenPort, bindAddress: cleanText(data.bindAddress, '0.0.0.0', 80), agentId, targetHost: data.targetHost.trim(), targetPort, entry: cleanText(data.entry, '本机入口', 80), exit: cleanText(data.exit, '目标服务', 80), status: 'running', runtimeStatus: 'stopped', lastError: '', bytesIn: 0, bytesOut: 0, connections: 0, createdAt: new Date().toISOString() };
}async function handleAuth(req, res, pathname) {
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const session = currentSession(req); const settings = readSettings();
    return json(res, 200, { authenticated: Boolean(session), username: session?.username || '', mustChangePassword: Boolean(session && settings.admin.mustChangePassword) });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const remote = req.socket.remoteAddress || 'unknown'; const attempt = loginAttempts.get(remote); const now = Date.now();
    if (attempt && attempt.until > now) return json(res, 429, { error: '登录尝试过多，请 15 分钟后再试' });
    const data = await body(req); const settings = readSettings();
    const valid = cleanText(data.username, '', 64) === settings.admin.username && typeof data.password === 'string' && crypto.timingSafeEqual(Buffer.from(passwordHash(data.password, settings.admin.salt).hash), Buffer.from(settings.admin.hash));
    if (!valid) {
      const count = (attempt && now - attempt.startedAt < 15 * 60 * 1000 ? attempt.count : 0) + 1;
      loginAttempts.set(remote, { count, startedAt: attempt?.startedAt || now, until: count >= 5 ? now + 15 * 60 * 1000 : 0 });
      return json(res, 401, { error: '用户名或密码错误' });
    }
    loginAttempts.delete(remote);
    const value = token(32); sessions.set(value, { username: settings.admin.username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return json(res, 200, { ok: true, mustChangePassword: settings.admin.mustChangePassword }, { 'Set-Cookie': sessionCookie(value, 8 * 60 * 60) });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = currentSession(req); if (session) sessions.delete(session.token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  return false;
}
async function handleRelays(req, res, parts) {
  const relayId = Number(parts[2]);
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, readStore(relayFile, seedRelays, normalizeRelay).map(relaySnapshot));
  if (parts.length === 2 && req.method === 'POST') {
    const relay = createRelay(await body(req)); if (!relay) return json(res, 400, { error: '请填写规则名称、协议、监听端口与目标地址' });
    const agents = readAgents(); if (relay.agentId && !agents.some(agent => agent.id === relay.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' });
    const relays = readStore(relayFile, seedRelays, normalizeRelay); const usesTcp = mode => mode === 'tcp' || mode === 'tcp+udp'; const usesUdp = mode => mode === 'udp' || mode === 'tcp+udp'; const overlaps = item => (item.agentId || '') === relay.agentId && item.listenPort === relay.listenPort && ((usesTcp(item.transport) && usesTcp(relay.transport)) || (usesUdp(item.transport) && usesUdp(relay.transport)));
    if (relays.some(overlaps)) return json(res, 409, { error: '该中转节点上监听端口与现有规则的传输协议冲突' });
    relays.unshift(relay);
    if (relay.agentId) { relay.runtimeStatus = 'starting'; } else { try { const snapshot = await startRelay(relay); Object.assign(relay, snapshot); } catch (error) { relay.status = 'stopped'; relay.runtimeStatus = 'error'; relay.lastError = error.message; } }
    writeStore(relayFile, relays); return json(res, 201, relaySnapshot(relay));
  }
  if (!Number.isInteger(relayId)) return json(res, 404, { error: 'Not found' });
  if (req.method === 'PATCH') {
    const data = await body(req); if (!statuses.has(data.status)) return json(res, 400, { error: '状态无效' }); const relays = readStore(relayFile, seedRelays, normalizeRelay); const relay = relays.find(item => item.id === relayId); if (!relay) return json(res, 404, { error: 'Not found' });
    if (relay.agentId) { relay.status = data.status; relay.runtimeStatus = data.status === 'running' ? 'starting' : 'stopped'; relay.lastError = ''; } else if (data.status === 'running') { try { const snapshot = await startRelay(relay); Object.assign(relay, snapshot, { status: 'running', lastError: '' }); } catch (error) { relay.status = 'stopped'; relay.runtimeStatus = 'error'; relay.lastError = error.message; } } else { stopRelay(relay.id); relay.status = 'stopped'; relay.runtimeStatus = 'stopped'; }
    writeStore(relayFile, relays); return json(res, 200, relaySnapshot(relay));
  }
  if (req.method === 'DELETE') { const relays = readStore(relayFile, seedRelays, normalizeRelay); if (!relays.some(item => item.id === relayId)) return json(res, 404, { error: 'Not found' }); stopRelay(relayId); writeStore(relayFile, relays.filter(item => item.id !== relayId)); return json(res, 204); }
  return json(res, 405, { error: 'Method not allowed' });
}async function handleInbounds(req, res, parts) {
  const inboundId = Number(parts[2]);
  if (parts.length === 4 && parts[3] === 'qr' && req.method === 'GET' && Number.isInteger(inboundId)) {
    const inbound = readStore(inboundFile, seedInbounds, normalizeInbound).find(item => item.id === inboundId); if (!inbound) return json(res, 404, { error: 'Not found' });
    const svg = await QRCode.toString(inbound.shareLink, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 280, color: { dark: '#202030', light: '#ffffffff' } }); res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(svg);
  }
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, readStore(inboundFile, seedInbounds, normalizeInbound).map(inboundSnapshot));
  if (parts.length === 3 && parts[2] === 'import-3xui' && req.method === 'POST') {
    let inbound; try { inbound = import3xuiInbound(await body(req)); } catch (error) { return json(res, 400, { error: error.message }); }
    const agents = readAgents(); if (inbound.agentId && !agents.some(agent => agent.id === inbound.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const scope = item => (item.agentId || '') === inbound.agentId;
    if (inbounds.some(item => scope(item) && item.port === inbound.port)) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' });
    const relays = readStore(relayFile, seedRelays, normalizeRelay); if (relays.some(relay => (relay.agentId || '') === inbound.agentId && relay.listenPort === inbound.port)) return json(res, 409, { error: '该执行节点的监听端口已被中转规则占用' });
    inbounds.unshift(inbound); writeStore(inboundFile, inbounds); if (!inbound.agentId && inbound.status === 'running') await ensureLocalRuntime(); return json(res, 201, inboundSnapshot(inbound));
  }
  if (parts.length === 2 && req.method === 'POST') {
    const inbound = buildNode(await body(req)); if (!inbound) return json(res, 400, { error: '节点名称、地址和端口必须有效' }); const agents = readAgents(); if (inbound.agentId && !agents.some(agent => agent.id === inbound.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const scope = item => (item.agentId || '') === inbound.agentId; if (inbounds.some(item => scope(item) && item.port === inbound.port)) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' }); const relays = readStore(relayFile, seedRelays, normalizeRelay); if (relays.some(relay => (relay.agentId || '') === inbound.agentId && relay.listenPort === inbound.port)) return json(res, 409, { error: '该执行节点的监听端口已被中转规则占用' });
    inbounds.unshift(inbound); writeStore(inboundFile, inbounds); if (!inbound.agentId) await ensureLocalRuntime(); return json(res, 201, inboundSnapshot(inbound));
  }
  if (!Number.isInteger(inboundId)) return json(res, 404, { error: 'Not found' });
  if (req.method === 'PATCH') {
    const data = await body(req); const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const index = inbounds.findIndex(item => item.id === inboundId); if (index < 0) return json(res, 404, { error: 'Not found' }); const inbound = inbounds[index];
    if (Object.prototype.hasOwnProperty.call(data, 'status') && Object.keys(data).length === 1) { if (!statuses.has(data.status)) return json(res, 400, { error: '状态无效' }); inbound.status = data.status; writeStore(inboundFile, inbounds); if (!inbound.agentId) { if (inbound.status === 'running') await ensureLocalRuntime(); else await syncRuntimeIfRunning(); } return json(res, 200, inboundSnapshot(inbound)); }
    let updated; try { updated = updateInbound(inbound, data); } catch (error) { return json(res, 400, { error: error.message }); } if (!updated) return json(res, 400, { error: '节点名称、地址和端口必须有效' });
    const agents = readAgents(); if (updated.agentId && !agents.some(agent => agent.id === updated.agentId && agent.enabled)) return json(res, 400, { error: '指定的 Agent 不存在或已停用' });
    if (inbounds.some(item => item.id !== inboundId && (item.agentId || '') === updated.agentId && item.port === updated.port)) return json(res, 409, { error: '该执行节点的监听端口已被入站占用' });
    const relays = readStore(relayFile, seedRelays, normalizeRelay); if (relays.some(relay => (relay.agentId || '') === updated.agentId && relay.listenPort === updated.port)) return json(res, 409, { error: '该执行节点的监听端口已被中转规则占用' });
    inbounds[index] = updated; writeStore(inboundFile, inbounds); if (!inbound.agentId || !updated.agentId) { if (!updated.agentId && updated.status === 'running') await ensureLocalRuntime(); else await syncRuntimeIfRunning(); } return json(res, 200, inboundSnapshot(updated));
  }
  if (req.method === 'DELETE') { const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const inbound = inbounds.find(item => item.id === inboundId); if (!inbound) return json(res, 404, { error: 'Not found' }); writeStore(inboundFile, inbounds.filter(item => item.id !== inboundId)); if (!inbound.agentId) await syncRuntimeIfRunning(); return json(res, 204); }
  return json(res, 405, { error: 'Method not allowed' });
}async function handleUsers(req, res, parts) {
  const userId = Number(parts[2]);
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, readStore(userFile, seedUsers));
  if (parts.length === 2 && req.method === 'POST') {
    const data = await body(req); const user = createUser(data); if (!user) return json(res, 400, { error: '请填写有效的用户名称、邮箱和配额' });
    const users = readStore(userFile, seedUsers); if (users.some(item => item.email.toLowerCase() === user.email)) return json(res, 409, { error: '该邮箱已存在' });
    const inboundId = Number(data.inboundId);
    if (data.inboundId && !Number.isInteger(inboundId)) return json(res, 400, { error: '入站选择无效' });
    if (inboundId) {
      const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); const inbound = inbounds.find(item => item.id === inboundId);
      if (!inbound) return json(res, 404, { error: '选定的入站不存在' });
      const access = userAccessForInbound(inbound, user); if (!access) return json(res, 400, { error: '该入站协议暂不支持用户分配' });
      user.access = [access]; setAccessActive(inbound, access, true); writeStore(inboundFile, inbounds); await syncRuntimeIfRunning();
    }
    users.unshift(user); writeStore(userFile, users); return json(res, 201, user);
  }
  if (!Number.isInteger(userId)) return json(res, 404, { error: 'Not found' });
  if (req.method === 'PATCH') {
    const data = await body(req); const users = readStore(userFile, seedUsers); const user = users.find(item => item.id === userId); if (!user) return json(res, 404, { error: 'Not found' });
    if (data.status !== undefined) {
      if (!statuses.has(data.status)) return json(res, 400, { error: '状态无效' }); user.status = data.status;
      const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); for (const access of user.access || []) setAccessActive(inbounds.find(item => item.id === access.inboundId), access, data.status === 'running'); writeStore(inboundFile, inbounds); await syncRuntimeIfRunning();
    }
    if (data.limitGB !== undefined) { const limit = Number(data.limitGB); if (!Number.isFinite(limit) || limit <= 0) return json(res, 400, { error: '配额无效' }); user.limitGB = Math.round(limit); }
    if (data.expire !== undefined) user.expire = cleanText(data.expire, '', 40); writeStore(userFile, users); return json(res, 200, user);
  }
  if (req.method === 'DELETE') {
    const users = readStore(userFile, seedUsers); const user = users.find(item => item.id === userId); if (!user) return json(res, 404, { error: 'Not found' });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); for (const access of user.access || []) setAccessActive(inbounds.find(item => item.id === access.inboundId), access, false); writeStore(inboundFile, inbounds); await syncRuntimeIfRunning();
    writeStore(userFile, users.filter(item => item.id !== userId)); return json(res, 204);
  }
  return json(res, 405, { error: 'Method not allowed' });
}function dateKey(value = new Date()) { return new Date(value).toISOString().slice(0, 10); }
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
    const reachedLimit = user.usedGB >= Number(user.limitGB || Infinity);
    if (reachedLimit) { user.status = 'stopped'; for (const access of user.access || []) setAccessActive(inbounds.find(item => item.id === access.inboundId), access, false); writeStore(inboundFile, inbounds); await syncRuntimeIfRunning(); }
    writeStore(userFile, users);
    const records = readStore(trafficFile, []); const record = { id: id(), userId: user.id, userName: user.name, inboundId: inbound?.id || null, inboundName: inbound?.name || '未指定入站', gb: Math.round(gb * 1000) / 1000, direction, at: new Date().toISOString(), source: 'manual' };
    records.unshift(record); writeStore(trafficFile, records.slice(0, 5000));
    return json(res, 201, { record, user, reachedLimit });
  }
  return json(res, 405, { error: 'Method not allowed' });
}function domainValid(domain) { return typeof domain === 'string' && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain.trim()); }
function tlsPublic(settings) {
  const tls = settings.tls; const hasFiles = Boolean(tls.certPath && tls.keyPath && fs.existsSync(tls.certPath) && fs.existsSync(tls.keyPath));
  return { ...tls, ready: hasFiles, restartRequired: hasFiles };
}
function certbotExists() { return spawnSync(process.platform === 'win32' ? 'where' : 'which', ['certbot'], { encoding: 'utf8' }).status === 0; }
function xrayCommand() { const local = path.join(root, 'runtime', process.platform === 'win32' ? 'xray.exe' : 'xray'); return fs.existsSync(local) ? local : cleanText(process.env.XRAY_BIN, process.platform === 'win32' ? 'xray.exe' : 'xray', 512); }
function xrayProbe() {
  const binary = xrayCommand(); const result = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.error || result.status !== 0) return { available: false, binary, version: '', error: result.error?.code === 'ENOENT' ? '未检测到 Xray Core' : (result.stderr || result.error?.message || 'Xray Core 不可用').slice(0, 240) };
  const version = (result.stdout || result.stderr || '').split(/\r?\n/)[0].trim(); const match = version.match(/Xray\s+([0-9]+(?:\.[0-9]+)+)/); return { available: true, binary, version, installedVersion: match ? `v${match[1]}` : '', error: '' };
}
function runtimeConfig() {
  const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound).filter(item => item.status === 'running' && !item.agentId).map(item => { const config = JSON.parse(JSON.stringify(item.xray)); if (config.listen === '') delete config.listen; return config; });
  return { log: { loglevel: 'warning' }, inbounds, outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'blocked' }] };
}
function runtimeInfo() {
  const probe = xrayProbe(); const running = Boolean(runtime.child && runtime.child.exitCode === null && !runtime.child.killed);
  return { ...probe, running, pid: running ? runtime.child.pid : null, startedAt: running ? runtime.startedAt : '', lastError: runtime.lastError, lastLog: runtime.lastLog, installing: runtime.installing, enabledInbounds: runtimeConfig().inbounds.length };
}
function appendRuntimeLog(value) { runtime.lastLog = `${runtime.lastLog}${String(value || '')}`.slice(-1500); }
function startRuntime() {
  const probe = xrayProbe(); if (!probe.available) return { error: probe.error };
  if (runtime.child && runtime.child.exitCode === null && !runtime.child.killed) return { info: runtimeInfo() };
  const config = runtimeConfig(); const validation = validateRuntimeConfig(config); if (!validation.ok) { runtime.lastError = validation.error; return { error: validation.error }; }
  writeStore(runtimeFile, config); runtime.lastError = ''; runtime.lastLog = '';
  const child = spawn(probe.binary, ['run', '-c', runtimeFile], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); runtime.child = child; runtime.startedAt = new Date().toISOString();
  child.stdout.on('data', appendRuntimeLog); child.stderr.on('data', appendRuntimeLog);
  child.on('error', error => { runtime.lastError = error.message; });
  child.on('exit', (code, signal) => { if (code && code !== 0) runtime.lastError = `Xray 已退出（code ${code}${signal ? `, ${signal}` : ''}）`; runtime.child = null; });
  return { info: runtimeInfo() };
}
function stopRuntime() { if (!runtime.child || runtime.child.exitCode !== null || runtime.child.killed) return false; runtime.child.kill(); return true; }
function validateRuntimeConfig(config) {
  const probe = xrayProbe(); if (!probe.available) return { ok: true, skipped: true };
  const file = path.join(root, `.runtime-check-${id()}.json`);
  try { fs.writeFileSync(file, JSON.stringify(config)); const result = spawnSync(probe.binary, ['run', '-test', '-c', file], { encoding: 'utf8', windowsHide: true, timeout: 15000 }); return result.status === 0 ? { ok: true } : { ok: false, error: (result.stderr || result.stdout || 'Xray 配置校验失败').slice(-900) }; }
  catch (error) { return { ok: false, error: error.message || 'Xray 配置校验失败' }; }
  finally { try { fs.unlinkSync(file); } catch {} }
}
function waitForExit(child) { return new Promise(resolve => { if (!child || child.exitCode !== null) return resolve(); const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
async function ensureLocalRuntime() {
  const info = runtimeInfo(); if (!info.available) return { error: info.error || '未检测到 Xray Core' };
  if (info.running) return syncRuntimeIfRunning();
  const started = startRuntime(); if (started.error) return { error: started.error };
  await new Promise(resolve => setTimeout(resolve, 450)); const current = runtimeInfo();
  return current.running ? { started: true } : { error: current.lastError || 'Xray Core 启动失败，请查看系统日志' };
}
async function syncRuntimeIfRunning() {
  const active = Boolean(runtime.child && runtime.child.exitCode === null && !runtime.child.killed); if (!active) return { reloaded: false };
  const config = runtimeConfig(); const check = validateRuntimeConfig(config); if (!check.ok) { runtime.lastError = `新配置未应用：${check.error}`; return { error: runtime.lastError }; }
  const previous = runtime.child; stopRuntime(); await waitForExit(previous); const started = startRuntime(); if (started.error) { runtime.lastError = started.error; return { error: started.error }; }
  await new Promise(resolve => setTimeout(resolve, 350)); if (!runtime.child || runtime.child.exitCode !== null || runtime.child.killed) return { error: runtime.lastError || 'Xray 重载后未保持运行' };
  runtime.lastLog = `配置已自动重载\n${runtime.lastLog}`.slice(-1500); return { reloaded: true };
}
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
}function requestBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('下载重定向次数过多'));
    https.get(url, { headers: { 'User-Agent': '3xUI-Lite-Core-Installer', Accept: 'application/vnd.github+json' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) return resolve(requestBuffer(new URL(response.headers.location, url).toString(), redirects + 1));
      if (response.statusCode !== 200) return reject(new Error(`下载失败（HTTP ${response.statusCode}）`));
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 120 * 1024 * 1024) response.destroy(new Error('下载文件过大')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    }).on('error', reject);
  });
}
function xrayReleaseAsset() {
  if (process.platform === 'win32' && process.arch === 'x64') return { archive: 'Xray-windows-64.zip', binary: 'xray.exe' };
  if (process.platform === 'linux' && process.arch === 'x64') return { archive: 'Xray-linux-64.zip', binary: 'xray' };
  if (process.platform === 'linux' && process.arch === 'arm64') return { archive: 'Xray-linux-arm64-v8a.zip', binary: 'xray' };
  if (process.platform === 'linux' && process.arch === 'arm') return { archive: 'Xray-linux-arm32-v7a.zip', binary: 'xray' };
  return null;
}
async function installXray() {
  if (runtime.installing) return { error: 'Xray Core 正在安装中' };
  if (runtime.child && runtime.child.exitCode === null && !runtime.child.killed) return { error: '请先停止正在运行的 Xray Core' };
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
    const target = path.join(root, 'runtime'); fs.mkdirSync(target, { recursive: true });
    for (const name of [targetAsset.binary, 'geoip.dat', 'geosite.dat']) { const from = path.join(out, name); if (fs.existsSync(from)) { const destination = path.join(target, name); fs.copyFileSync(from, destination); if (name === targetAsset.binary && process.platform !== 'win32') fs.chmodSync(destination, 0o755); } }
    runtime.lastLog = `已安装 Xray Core ${release.tag_name || ''}`; return { info: runtimeInfo(), version: release.tag_name || '' };
  } catch (error) { runtime.lastError = error.message || 'Xray Core 安装失败'; return { error: runtime.lastError }; }
  finally { runtime.installing = false; fs.rmSync(temp, { recursive: true, force: true }); }
}async function handleRuntime(req, res, parts) {
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, runtimeInfo());
  if (parts.length === 3 && parts[2] === 'config' && req.method === 'GET') return json(res, 200, runtimeConfig());
  if (parts.length === 3 && parts[2] === 'install' && req.method === 'POST') { const data = await body(req); const result = await installXray(data.version); return result.error ? json(res, 422, { error: result.error, runtime: runtimeInfo() }) : json(res, 201, result); }
  if (parts.length === 3 && parts[2] === 'start' && req.method === 'POST') { const result = startRuntime(); return result.error ? json(res, 409, { error: result.error, runtime: runtimeInfo() }) : json(res, 200, result.info); }
  if (parts.length === 3 && parts[2] === 'stop' && req.method === 'POST') { stopRuntime(); return json(res, 200, runtimeInfo()); }
  return json(res, 405, { error: 'Method not allowed' });
}async function handleSystem(req, res, pathname) {
  const settings = readSettings();
  if (pathname === '/api/system' && req.method === 'GET') return json(res, 200, { admin: { username: settings.admin.username, mustChangePassword: settings.admin.mustChangePassword }, tls: tlsPublic(settings), certbotAvailable: certbotExists(), runtime: runtimeInfo(), network: networkInfo() });
  if (pathname === '/api/system/network' && req.method === 'GET') return json(res, 200, networkInfo());
  if (pathname === '/api/system/network/detect' && req.method === 'POST') return json(res, 200, await detectPublicAddress(true));  if (pathname === '/api/system/password' && req.method === 'POST') {
    const data = await body(req); const candidate = typeof data.currentPassword === 'string' ? passwordHash(data.currentPassword, settings.admin.salt).hash : '';
    if (!candidate || !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(settings.admin.hash))) return json(res, 400, { error: '当前密码不正确' });
    if (typeof data.newPassword !== 'string' || data.newPassword.length < 10 || data.newPassword.length > 128) return json(res, 400, { error: '新密码需为 10–128 个字符' });
    if (data.newPassword === data.currentPassword) return json(res, 400, { error: '新密码不能与当前密码相同' });
    Object.assign(settings.admin, passwordHash(data.newPassword), { mustChangePassword: false }); writeSettings(settings); sessions.clear();
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (pathname === '/api/system/tls' && req.method === 'POST') {
    const data = await body(req); const domain = cleanText(data.domain, '', 253).toLowerCase(); const email = cleanText(data.email, '', 100); const certPath = cleanText(data.certPath, '', 512); const keyPath = cleanText(data.keyPath, '', 512);
    if (!domainValid(domain) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '请填写有效域名和通知邮箱' });
    if (Boolean(certPath) !== Boolean(keyPath)) return json(res, 400, { error: '证书和私钥路径必须同时填写' });
    settings.tls = { domain, email, certPath, keyPath, updatedAt: new Date().toISOString() }; writeSettings(settings);
    return json(res, 200, { tls: tlsPublic(settings) });
  }
  if (pathname === '/api/system/tls/request' && req.method === 'POST') {
    const data = await body(req); const domain = cleanText(data.domain, '', 253).toLowerCase(); const email = cleanText(data.email, '', 100);
    if (!domainValid(domain) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '请填写有效域名和通知邮箱' });
    if (!certbotExists()) return json(res, 409, { error: '未检测到 certbot。请在服务器安装 certbot 后重试：apt install certbot（Debian/Ubuntu）。' });
    const result = spawnSync('certbot', ['certonly', '--webroot', '-w', root, '-d', domain, '--email', email, '--agree-tos', '--non-interactive', '--keep-until-expiring'], { encoding: 'utf8', timeout: 180000 });
    if (result.error || result.status !== 0) return json(res, 422, { error: `证书申请失败：${(result.stderr || result.stdout || result.error?.message || '未知错误').slice(0, 800)}` });
    settings.tls = { domain, email, certPath: `/etc/letsencrypt/live/${domain}/fullchain.pem`, keyPath: `/etc/letsencrypt/live/${domain}/privkey.pem`, updatedAt: new Date().toISOString() }; writeSettings(settings);
    return json(res, 200, { tls: tlsPublic(settings), message: '证书已申请。请应用到 TLS 入站并重启面板 HTTPS 服务。' });
  }
  if (pathname === '/api/system/tls/apply' && req.method === 'POST') {
    if (!settings.tls.certPath || !settings.tls.keyPath || !fs.existsSync(settings.tls.certPath) || !fs.existsSync(settings.tls.keyPath)) return json(res, 400, { error: '证书文件不可用，请先保存正确路径或申请证书' });
    const inbounds = readStore(inboundFile, seedInbounds, normalizeInbound); let changed = 0;
    for (const inbound of inbounds) if (inbound.protocolCode === 'trojan') { inbound.streamSettings.tlsSettings = { ...(inbound.streamSettings.tlsSettings || {}), certificates: [{ certificateFile: settings.tls.certPath, keyFile: settings.tls.keyPath }] }; inbound.xray.streamSettings = inbound.streamSettings; changed++; }
    writeStore(inboundFile, inbounds); await syncRuntimeIfRunning(); return json(res, 200, { changed, message: `已将证书写入 ${changed} 个 Trojan TLS 入站。` });
  }
  return json(res, 405, { error: 'Method not allowed' });
}
async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`); const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname.startsWith('/api/auth/')) { const handled = await handleAuth(req, res, url.pathname); if (handled !== false) return; return json(res, 404, { error: 'Not found' }); }
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (parts[0] === 'api' && parts[1] === 'agent') return handleAgentGateway(req, res, parts);
    if (parts[0] === 'api') {
      if (!requireAuth(req, res)) return;
      if (parts[1] === 'relays') return handleRelays(req, res, parts);
      if (parts[1] === 'agents') return handleAgents(req, res, parts);
      if (parts[1] === 'inbounds') return handleInbounds(req, res, parts);
      if (parts[1] === 'users') return handleUsers(req, res, parts);
      if (parts[1] === 'traffic') return handleTraffic(req, res, parts);
      if (parts[1] === 'runtime') return handleRuntime(req, res, parts);
      if (parts[1] === 'system') return handleSystem(req, res, url.pathname);
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const file = path.resolve(root, requested);
    if (!file.startsWith(root + path.sep) || (privateFiles.has(requested) || requested.startsWith('runtime/') || requested.startsWith('.xray-install-')) || !fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  } catch (error) { json(res, 500, { error: error.message || 'Server error' }); }
}
const server = http.createServer(requestHandler);
if (require.main === module) {
  const panelHost = process.env.PANEL_HOST || '0.0.0.0';
  server.listen(port, panelHost, () => {
    console.log('3xUI Lite HTTP: http://' + panelHost + ':' + port);
    for (const relay of readStore(relayFile, seedRelays, normalizeRelay)) if (relay.status === 'running' && relay.listenPort && !relay.agentId) startRelay(relay).catch(error => console.error(`Relay ${relay.name} failed: ${error.message}`));
    if (runtimeConfig().inbounds.length) { const started = startRuntime(); if (started.error) { runtime.lastError = started.error; console.error(`Xray startup failed: ${started.error}`); } }
  });
  const bootTls = readSettings().tls;
  if (bootTls.certPath && bootTls.keyPath && fs.existsSync(bootTls.certPath) && fs.existsSync(bootTls.keyPath)) {
    const httpsPort = Number(process.env.HTTPS_PORT || 3443);
    https.createServer({ cert: fs.readFileSync(bootTls.certPath), key: fs.readFileSync(bootTls.keyPath) }, requestHandler).listen(httpsPort, panelHost, () => console.log(`3xUI Lite HTTPS: https://${panelHost}:${httpsPort}`));
  }
}
module.exports = { server, buildNode, import3xuiInbound, createUser, readSettings };


















