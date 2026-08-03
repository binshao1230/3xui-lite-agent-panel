const zh = {
  run: '运行中', stop: '已暂停', pause: '暂停', enable: '启用', del: '删除', copyLink: '复制链接', copyJson: '复制 JSON', copied: '已复制',
  emptyRelay: '没有符合条件的中转规则。', emptyInbound: '暂无入站节点。', emptyUser: '暂无用户。',
  confirmRelay: '确定删除这条中转规则吗？', confirmInbound: '确定删除这个节点吗？', confirmUser: '确定删除这个用户吗？',
  listen: '监听端口', server: '服务器', security: '安全层', template: '模板', remark: '备注', noRemark: '未填写', link: '节点链接', apiFailed: '读取数据失败，请确认服务已启动并重新登录。'
};
const pageNames = { overview: '概览', inbounds: '入站管理', relays: '中转面板', users: '用户管理', traffic: '流量统计', system: '系统设置' };
pageNames.agents = 'Agent 管理';
const inboundTemplates = {
  'VLESS + Reality': { key: 'reality', name: 'VLESS Reality 模板', desc: 'TCP + REALITY，自动生成 UUID、公私钥、shortId 和 vless:// 链接。', defaults: { port: '443', sni: 'www.microsoft.com', dest: 'www.microsoft.com:443', fingerprint: 'chrome', flow: 'xtls-rprx-vision' } },
  VLESS: { key: 'vless', name: '纯 VLESS TCP 模板', desc: 'TCP + 无传输安全层，自动生成 UUID 和 vless:// 链接。适合置于反向代理或内网转发之后。', defaults: { port: '8080' } },
  'VLESS + TLS': { key: 'tls', name: 'VLESS TLS 模板', desc: 'TCP + TLS，自动生成 UUID；本机使用系统证书，Agent 请填写该机器的证书路径。', defaults: { port: '443', sni: '' } },
  'VLESS + WebSocket': { key: 'ws', name: 'VLESS WebSocket + TLS 模板', desc: 'WS + TLS，适合经由 Nginx、CDN 或反向代理接入。', defaults: { port: '443', sni: '', path: '/vless', host: '' } },
  'VLESS + gRPC': { key: 'grpc', name: 'VLESS gRPC + TLS 模板', desc: 'gRPC + TLS，自动使用 serviceName；适合 HTTP/2 反向代理场景。', defaults: { port: '443', sni: '', serviceName: 'vless-grpc' } },  'Trojan + TLS': { key: 'tls', name: 'Trojan TLS 模板', desc: 'TCP + TLS，自动生成 Trojan 密码和 trojan:// 链接；远程 Agent 需填写证书路径。', defaults: { port: '443', sni: '', fingerprint: 'chrome' } },
  Shadowsocks: { key: 'ss', name: 'Shadowsocks 2022 模板', desc: 'TCP/UDP SS2022，自动生成服务端 PSK、用户 PSK 和 ss:// 链接。', defaults: { port: '8388', method: '2022-blake3-aes-128-gcm' } }
};
let relays = [], inbounds = [], users = [], agents = [], auditEntries = [], filter = 'all', systemInfo = null, traffic = null, editingInboundId = null, editingRelayId = null, editingUserId = null, auditAvailable = false;
const selectedRelayIds = new Set();
let agentFilter = 'all', operationsRefreshPromise = null, lastOperationsSyncAt = null, diagnosticsText = '', refreshFailureNotifiedAt = 0, fleetUpdateInProgress = false;
const agentCardCollapsed = new Set((() => { try { const value = JSON.parse(localStorage.getItem('3xui-agent-collapsed') || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } })());
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match]));
const loginDefaultNote = '请输入管理员凭据。首次部署请查看安装输出中的初始凭据。';
function suggestedControllerUrl(value = location.origin) {
  try {
    const url = new URL(value); const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase(); const loopback = host === 'localhost' || host === '::1' || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.origin : '';
  } catch { return ''; }
}

let applicationLocked = true;
const mobileNavigation = window.matchMedia('(max-width: 900px)');
function syncApplicationAccess() {
  const sidebar = $('.sidebar'), main = $('main'), mobileSidebarHidden = mobileNavigation.matches && !sidebar.classList.contains('open');
  const sidebarLocked = applicationLocked || mobileSidebarHidden;
  sidebar.toggleAttribute('inert', sidebarLocked); if (sidebarLocked) sidebar.setAttribute('aria-hidden', 'true'); else sidebar.removeAttribute('aria-hidden');
  main.toggleAttribute('inert', applicationLocked); if (applicationLocked) main.setAttribute('aria-hidden', 'true'); else main.removeAttribute('aria-hidden');
}
function setApplicationLocked(locked) { applicationLocked = locked; syncApplicationAccess(); }

function clearAuthenticatedState() {
  relays = []; inbounds = []; users = []; agents = []; auditEntries = []; systemInfo = null; traffic = null; editingInboundId = null; editingRelayId = null; editingUserId = null; auditAvailable = false; selectedRelayIds.clear(); lastOperationsSyncAt = null;
  ['#cards', '#inboundCards', '#userCards', '#agentCards', '#health', '#trafficDays', '#trafficInbounds', '#trafficUsers', '#trafficLog', '#auditLog', '#securityChecks', '#agentDetailsBody', '#agentCommand', '#toastStack', '#diagnosticsBody'].forEach(selector => $(selector)?.replaceChildren());
  $('#overviewChart').innerHTML = '<p class="empty-state">暂无流量数据。</p>';
  $('#inboundCount').innerHTML = '0 <small>在线 / 0 已启用 · 共 0</small>'; $('#activeCount').textContent = '0'; $('#userCount').textContent = '0';
  ['#agentOnlineCount', '#agentOfflineCount', '#agentIssueCount', '#agentResourceCount', '#relayTotalCount', '#relayRunningCount', '#relayIssueCount', '#relayConnectionCount'].forEach(selector => { const target = $(selector); if (target) target.textContent = '0'; }); $('#agentOnlineRate').textContent = '在线率 0%'; $('#relayAvailability').textContent = '可用率 0%'; $('#relayTrafficTotal').textContent = '累计 0 B'; setOperationsSync('', '等待同步'); updateRelayBatchBar();
  $('#overviewTraffic').innerHTML = '0 <small>GB</small>'; $('#overviewTrafficNote').textContent = '暂无流量记录';
  $('#trafficTotal').innerHTML = '0 <small>GB</small>'; $('#trafficRecorded').innerHTML = '0 <small>GB</small>'; $('#trafficActive').textContent = '0'; $('#trafficRecords').textContent = '0';
  $('#adminName').textContent = '-'; $('#tlsSummary').textContent = '登录后读取证书状态。'; $('#securitySummary').textContent = '登录后评估面板安全状态。'; $('#securityGrade').textContent = '--'; $('#securityGrade').className = 'security-grade';
  $('#runtimeVersion').textContent = '未读取'; $('#runtimeSummary').textContent = '登录后检查 Xray Core。'; $('#runtimeDetail').textContent = ''; $('#publicAddress').textContent = '未读取'; $('#publicAddressDetail').textContent = '';
  $('#certStatus').textContent = '未读取'; $('#certStatus').className = 'cert-status';
  $('#relayAgent').innerHTML = '<option value="">本机面板</option>'; $('#inboundAgent').innerHTML = '<option value="">本机面板 Xray</option>'; $('#importInboundAgent').innerHTML = '<option value="">本机面板 Xray</option>';
  $('#userInbound').innerHTML = '<option value="">仅创建用户档案</option>'; $('#trafficUser').replaceChildren(); $('#trafficInbound').innerHTML = '<option value="">未指定入站</option>';
  $('#relayModalTitle').textContent = '创建端口转发'; $('#inboundModalTitle').textContent = '生成入站节点'; $('#userModalTitle').textContent = '创建用户'; $('#qrTitle').textContent = '节点二维码'; $('#agentBootstrapTitle').textContent = '部署 Agent'; $('#agentDetailsTitle').textContent = 'Agent 详情';
  $('#coreVersion').value = ''; $('#coreVersion').placeholder = '版本，如 v26.3.27'; $('#qrImage').removeAttribute('src'); $('#tlsForm').reset(); document.querySelectorAll('dialog form').forEach(form => form.reset());
}

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const payload = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(payload.error || '请求失败'); error.status = res.status; error.code = payload.code || '';
    if (res.status === 401) { clearAuthenticatedState(); showLogin(url === '/api/auth/login' ? '' : '会话已失效，请重新登录。'); }
    if (error.code === 'PASSWORD_CHANGE_REQUIRED') forcePasswordChange();
    throw error;
  }
  return payload;
}
function showLogin(note = '') {
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); closeSidebar();
  const gate = $('#loginGate'); gate.classList.remove('hidden'); gate.removeAttribute('aria-hidden'); setApplicationLocked(true);
  $('#loginNote').textContent = note || loginDefaultNote;
  const password = $('#loginForm input[name="password"]'), focusPassword = () => { const active = document.activeElement; if (!active || active === gate || !gate.contains(active)) password?.focus({ preventScroll: true }); }; focusPassword(); requestAnimationFrame(focusPassword); setTimeout(focusPassword, 250);
}
function hideLogin() { const gate = $('#loginGate'); gate.classList.add('hidden'); gate.setAttribute('aria-hidden', 'true'); setApplicationLocked(false); }
function focusActivePage() {
  const heading = $('.page.active h1') || $('main'); if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true });
}
function openDialog(dialog, preferredSelector = '') {
  if (!dialog.open) dialog.showModal();
  const target = (preferredSelector && dialog.querySelector(preferredSelector)) || dialog.querySelector('input:not([type="hidden"]):not(:disabled),select:not(:disabled),textarea:not(:disabled)') || dialog.querySelector('h2') || dialog.querySelector('button,a[href]');
  if (!target) return;
  if (!target.matches('button,a[href],input,select,textarea,[tabindex]')) target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true });
}
function toast(message, type = 'info') {
  const item = document.createElement('div'); item.className = `toast ${type}`; item.textContent = message; $('#toastStack').appendChild(item); setTimeout(() => item.remove(), 4200);
}
function forcePasswordChange() {
  hideLogin(); const modal = $('#passwordModal'); modal.dataset.required = 'true'; $('#passwordRequirement').hidden = false;
  if (!modal.open) $('#passwordForm').reset(); openDialog(modal);
}
function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function relayState(relay) { return relay.runtimeStatus || relay.status || 'stopped'; }
function inboundDesiredState(inbound) { return inbound.desiredStatus || inbound.status || 'stopped'; }
function relayNeedsAttention(relay) { return ['error', 'offline', 'disabled', 'starting', 'stopping', 'legacy'].includes(relayState(relay)); }
function relayStateText(state, relay = null) {
  return state === 'running' ? '运行中' : state === 'error' ? '异常' : state === 'legacy' ? '需迁移' : state === 'starting' ? '等待 Agent' : state === 'stopping' ? (relay?.pendingRemoteAction === 'delete' ? '等待删除确认' : '等待停止确认') : state === 'offline' ? 'Agent 离线' : state === 'disabled' ? 'Agent 停用' : '已暂停';
}
function formatRelativeTime(value) {
  const time = Date.parse(value || ''); if (!Number.isFinite(time)) return '从未同步';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 10) return '刚刚'; if (seconds < 60) return `${seconds} 秒前`; const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`; const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`; return `${Math.floor(hours / 24)} 天前`;
}
function setOperationsSync(state, message = '') {
  const fallback = lastOperationsSyncAt ? `已同步 ${lastOperationsSyncAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '等待同步';
  ['#relaySyncState', '#agentSyncState'].forEach(selector => { const target = $(selector); if (!target) return; target.className = `sync-state ${state}`; target.textContent = message || fallback; });
}
function renderRelayExecutorFilter() {
  const select = $('#relayExecutorFilter'); if (!select) return; const previous = select.value || 'all';
  select.innerHTML = '<option value="all">全部节点</option><option value="local">本机面板</option>' + agents.map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)} · ${agent.status === 'online' ? '在线' : agent.status === 'disabled' ? '停用' : '离线'}</option>`).join('');
  select.value = [...select.options].some(option => option.value === previous) ? previous : 'all';
}
function updateRelayBatchBar() {
  const bar = $('#relayBatchBar'); if (!bar) return; const count = selectedRelayIds.size;
  bar.hidden = count === 0; $('#relaySelectedCount').textContent = `已选择 ${count} 条`;
}
window.selectRelay = (id, checked) => {
  if (checked) selectedRelayIds.add(Number(id)); else selectedRelayIds.delete(Number(id));
  const card = document.querySelector(`.relay-card[data-relay-id="${Number(id)}"]`); card?.classList.toggle('selected', checked); updateRelayBatchBar();
};
function renderRelays() {
  renderRelayExecutorFilter();
  const search = ($('#search')?.value || '').trim().toLowerCase(); const executor = $('#relayExecutorFilter')?.value || 'all';
  const selectable = new Set(relays.filter(relay => relayState(relay) !== 'stopping').map(relay => Number(relay.id))); [...selectedRelayIds].forEach(id => { if (!selectable.has(id)) selectedRelayIds.delete(id); });
  const list = relays.filter(relay => {
    const state = relayState(relay); const stateMatch = filter === 'all' || (filter === 'error' ? relayNeedsAttention(relay) : state === filter);
    const executorMatch = executor === 'all' || (executor === 'local' ? !relay.agentId : relay.agentId === executor);
    const haystack = [relay.name, relay.listenPort, relay.bindAddress, relay.targetHost, relay.targetPort, relay.entry, relay.exit, relay.agentName, relay.agentId, relay.transport].join(' ').toLowerCase();
    return stateMatch && executorMatch && (!search || haystack.includes(search));
  });
  const running = relays.filter(relay => relayState(relay) === 'running').length; const issues = relays.filter(relayNeedsAttention).length;
  const connections = relays.reduce((sum, relay) => sum + Math.max(0, Number(relay.connections || 0)), 0); const trafficTotal = relays.reduce((sum, relay) => sum + Math.max(0, Number(relay.bytesIn || 0)) + Math.max(0, Number(relay.bytesOut || 0)), 0);
  $('#relayTotalCount').textContent = relays.length; $('#relayRunningCount').textContent = running; $('#relayIssueCount').textContent = issues; $('#relayConnectionCount').textContent = connections;
  $('#relayAvailability').textContent = `可用率 ${relays.length ? Math.round(running / relays.length * 100) : 0}%`; $('#relayTrafficTotal').textContent = `累计 ${formatBytes(trafficTotal)}`;
  $('#cards').innerHTML = list.length ? list.map(relay => {
    const state = relayState(relay), desired = relay.status || 'stopped', selected = selectedRelayIds.has(Number(relay.id)); const listen = relay.listenPort ? `${relay.bindAddress || '0.0.0.0'}:${relay.listenPort}` : '旧版档案'; const target = relay.targetHost ? `${relay.targetHost}:${relay.targetPort}` : (relay.exit || '需补充目标地址');
    const executor = relay.agentId ? `Agent · ${relay.agentName || relay.agentId}` : '本机面板'; const errorState = relayNeedsAttention(relay); const detail = errorState ? (relay.lastError || (state === 'starting' ? '等待 Agent 应用当前配置' : state === 'stopping' ? '等待 Agent 确认远程规则已停止' : '规则尚未运行')) : `连接 ${Number(relay.connections || 0)} · ↑${formatBytes(relay.bytesIn)} ↓${formatBytes(relay.bytesOut)}`;
    const controls = state === 'legacy' ? `<button class="btn danger" onclick="deleteRelay(${relay.id})">删除</button>` : state === 'stopping' ? `<button class="btn" onclick="diagnoseRelay(${relay.id})">诊断</button><button class="btn" disabled>等待确认</button><button class="btn danger" title="等待 Agent 确认" aria-label="等待确认 ${esc(relay.name)}" disabled>×</button>` : `<button class="btn" onclick="editRelay(${relay.id})">编辑</button><button class="btn" onclick="diagnoseRelay(${relay.id})">诊断</button><button class="btn primary-action" onclick="toggleRelay(${relay.id})" ${state === 'starting' ? 'disabled' : ''}>${desired === 'running' ? '暂停' : '启用'}</button><button class="btn danger" title="删除规则" aria-label="删除 ${esc(relay.name)}" onclick="deleteRelay(${relay.id})">×</button>`;
    return `<article class="relay-card relay-${esc(state)} ${selected ? 'selected' : ''}" data-relay-id="${relay.id}"><label class="relay-select" title="${state === 'stopping' ? '等待 Agent 确认期间不可批量操作' : `选择 ${esc(relay.name)}`}"><input type="checkbox" ${selected ? 'checked' : ''} ${state === 'stopping' ? 'disabled' : ''} aria-label="选择 ${esc(relay.name)}" onchange="selectRelay(${relay.id}, this.checked)"><span></span></label><div class="relay-main"><div class="name"><b>⇄</b><div><strong title="${esc(relay.name)}">${esc(relay.name)}</strong><small>${esc(executor)}</small></div></div><div class="relay-tags"><span class="relay-tag">${esc(String(relay.transport || 'tcp').toUpperCase())}</span><span class="relay-tag">${desired === 'running' ? '期望运行' : '期望暂停'}</span></div></div><div class="route"><b title="${esc(listen)}">${esc(listen)}</b><i></i><span title="${esc(target)}">${esc(target)}</span><small>${esc(relay.entry || '入口端口')} → ${esc(relay.exit || '目标服务')}</small></div><div class="relay-health"><span class="state-pill ${esc(state)}">${relayStateText(state, relay)}</span><small class="${errorState ? 'error-copy' : ''}" title="${esc(detail)}">${esc(detail)}</small></div><div class="relay-actions">${controls}</div></article>`;
  }).join('') : `<article class="empty-operation"><b>⇄</b><strong>${relays.length ? '没有符合筛选条件的线路' : '还没有中转线路'}</strong><p>${relays.length ? '调整搜索关键词、节点或状态筛选后重试。' : '创建第一条规则后即可在这里查看实时状态、连接和流量。'}</p>${relays.length ? '' : '<button class="primary" type="button" onclick="document.querySelector(\'#newRelay\').click()">新建中转</button>'}</article>`;
  $('#activeCount').textContent = running; updateRelayBatchBar();
  const overview = [...relays].sort((a, b) => Number(relayNeedsAttention(b)) - Number(relayNeedsAttention(a))).slice(0, 6);
  $('#health').innerHTML = overview.length ? overview.map(relay => { const state = relayState(relay), listen = relay.listenPort ? `${relay.bindAddress || '0.0.0.0'}:${relay.listenPort}` : '需迁移', target = relay.targetHost ? `${relay.targetHost}:${relay.targetPort}` : (relay.exit || '旧版档案'); return `<div class="healthrow"><i class="${state === 'running' ? '' : 'off'}"></i><div><strong>${esc(relay.name)}</strong><br><small>${esc(listen)} → ${esc(target)}</small></div><small>${state === 'running' ? `↑${formatBytes(relay.bytesIn)} ↓${formatBytes(relay.bytesOut)}` : esc(relayStateText(state, relay))}</small></div>`; }).join('') : '<p class="empty-state">暂无中转线路。</p>';
}
function populateRelayAgents(selected = '') {
  const select = $('#relayAgent'); if (!select) return;
  const selectedId = String(selected || ''); const current = agents.find(agent => agent.id === selectedId);
  const options = agents.filter(agent => agent.status !== 'disabled' || agent.id === selectedId).map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)} · ${agent.status === 'online' ? '在线' : agent.status === 'disabled' ? '已停用（当前绑定）' : '离线'}</option>`).join('');
  const missing = selectedId && !current ? `<option value="${esc(selectedId)}">未知 Agent ${esc(selectedId)} · 当前绑定</option>` : '';
  select.innerHTML = '<option value="">本机面板</option>' + missing + options; select.value = selectedId;
  select.dataset.initialAgentId = selectedId; select.dataset.initialAgentDisabled = String(Boolean(selectedId && (!current || current.status === 'disabled')));
}
function agentDisablePending(agent) { return agent?.status === 'disabled' && !agent.disabledAckAt; }
function agentStateText(agent) { return agentDisablePending(agent) ? '停用确认中' : agent?.status === 'online' ? '在线' : agent?.status === 'disabled' ? '已停用' : '离线'; }
function inboundStateText(state) { return state === 'running' ? '运行中' : state === 'starting' ? '下发中' : state === 'stopping' ? '停用确认中' : state === 'error' ? '异常' : state === 'offline' ? 'Agent 离线' : state === 'disabled' ? 'Agent 已停用' : '已暂停'; }
function desiredStateText(state) { return state === 'running' ? '运行' : '暂停'; }
function agentHasIssue(agent) {
  return agentDisablePending(agent) || agent.controllerSecure === false || Boolean(agent.updateError || agent.xrayInstallError) || (agent.status === 'online' && !agent.xrayAvailable);
}
function agentMaintenanceActive(agent) { return Boolean(agent?.updatePending || agent?.xrayInstallPending || agent?.xrayInstalling); }
function renderAgents() {
  const search = ($('#agentSearch')?.value || '').trim().toLowerCase(); const statusFilter = $('#agentStatusFilter')?.value || agentFilter || 'all';
  const online = agents.filter(agent => agent.status === 'online').length; const offline = agents.filter(agent => agent.status !== 'online').length; const issues = agents.filter(agentHasIssue).length;
  const resources = agents.reduce((sum, agent) => sum + inbounds.filter(item => item.agentId === agent.id).length + relays.filter(item => item.agentId === agent.id).length, 0);
  $('#agentOnlineCount').textContent = online; $('#agentOfflineCount').textContent = offline; $('#agentIssueCount').textContent = issues; $('#agentResourceCount').textContent = resources; $('#agentOnlineRate').textContent = `在线率 ${agents.length ? Math.round(online / agents.length * 100) : 0}%`;
  const eligibleUpdates = agents.filter(agent => agent.status === 'online' && !agentMaintenanceActive(agent));
  if (!fleetUpdateInProgress) { $('#updateOnlineAgents').disabled = eligibleUpdates.length === 0; $('#updateOnlineAgents').textContent = eligibleUpdates.length ? `更新在线 Agent（${eligibleUpdates.length}）` : '更新在线 Agent'; }
  const list = agents.filter(agent => {
    const issue = agentHasIssue(agent), operationalStatus = agentDisablePending(agent) ? 'stopping' : agent.status; const stateMatch = statusFilter === 'all' || (statusFilter === 'issue' ? issue : operationalStatus === statusFilter);
    const haystack = [agent.name, agent.id, agent.hostname, agent.platform, agent.arch, ...(agent.addresses || [])].join(' ').toLowerCase();
    return stateMatch && (!search || haystack.includes(search));
  });
  $('#agentCards').innerHTML = list.length ? list.map(agent => {
    const status = agent.status || 'offline', disablePending = agentDisablePending(agent), stateText = agentStateText(agent); const freshness = formatRelativeTime(agent.lastSeenAt);
    const memoryUsed = Math.max(0, Number(agent.memoryTotal || 0) - Number(agent.memoryFree || 0)); const memoryPercent = agent.memoryTotal ? Math.min(100, Math.round(memoryUsed / Number(agent.memoryTotal) * 100)) : 0;
    const assignedInbounds = inbounds.filter(item => item.agentId === agent.id), assignedRelays = relays.filter(item => item.agentId === agent.id); const runningInbounds = assignedInbounds.filter(item => item.status === 'running').length; const runningRelays = assignedRelays.filter(item => relayState(item) === 'running').length;
    const system = [agent.hostname, agent.platform, agent.arch].filter(Boolean).join(' · ') || '等待首次心跳'; const ips = (agent.addresses || []).join(', ') || '尚未上报地址'; const xrayText = agent.xrayInstallPending ? '安装任务排队中' : agent.xrayInstalling ? '正在安装 Xray' : agent.xrayAvailable ? agent.xrayVersion || 'Xray 可用' : '未检测到 Xray';
    const warning = disablePending ? (agent.safeStopAckCapable === false ? '当前 Agent 版本无法可信确认存量连接已关闭；请打开部署命令升级至 v0.5.7 或更高版本。' : agent.xrayInstalling ? '停用请求已记录；Agent 最后上报仍在安装 Xray，等待其停止全部工作负载并确认。' : '等待 Agent 下次心跳停止全部工作负载并确认。') : agent.controllerSecure === false ? '控制链路不安全，请立即迁移到 HTTPS。' : agent.updateError ? `Agent 更新失败：${agent.updateError}` : agent.xrayInstallError ? `Xray 安装失败：${agent.xrayInstallError}` : status === 'offline' ? '节点已离线；以下指标来自最后一次心跳。' : status === 'disabled' ? '节点已停用，不再接收配置和任务。' : !agent.xrayAvailable ? '未检测到 Xray Core，远程入站无法运行。' : '';
    const pending = agentMaintenanceActive(agent); const alertText = disablePending ? warning : pending ? (agent.updatePending ? 'Agent 更新任务已下发，等待节点执行并确认。' : xrayText) : warning;
    const onlineActionsDisabled = status !== 'online'; const safeId = esc(agent.id), actionId = esc(JSON.stringify(String(agent.id)));
    const configurationDisabled = status === 'disabled';
    return `<article class="agent-card ${status !== 'online' ? 'agent-stale' : ''}"><div class="agent-card-head"><div class="agent-title"><b>◉</b><div><strong title="${esc(agent.name)}">${esc(agent.name)}</strong><small>${safeId}</small></div></div><div class="agent-head-status"><span class="state-pill ${disablePending ? 'stopping' : esc(status)}">${stateText}</span><small title="${esc(agent.lastSeenAt || '')}">${esc(freshness)}</small></div></div><div class="agent-health-strip"><div class="agent-health-cell"><small>主机 / 系统</small><strong title="${esc(system)}">${esc(system)}</strong><small title="${esc(ips)}">${esc(ips)}</small></div><div class="agent-health-cell"><small>内存 / CPU</small><strong>${agent.memoryTotal ? `${formatBytes(memoryUsed)} / ${formatBytes(agent.memoryTotal)}` : '-'} · ${Number(agent.cpus || 0) || '-'} 核</strong><div class="mini-meter"><i style="width:${memoryPercent}%"></i></div></div><div class="agent-health-cell"><small>版本 / 承载</small><strong>Agent ${esc(agent.version || '-')} · Node ${esc(agent.nodeVersion || '-')}</strong><small>${esc(xrayText)} · 入站 ${runningInbounds}/${assignedInbounds.length} · 中转 ${runningRelays}/${assignedRelays.length}</small></div></div>${alertText ? `<div class="agent-alert ${pending || disablePending ? 'pending' : ''}">${esc(alertText)}</div>` : ''}<div class="agent-card-actions"><button class="btn primary-action" onclick="configureAgentInbound(${actionId})" ${configurationDisabled ? 'disabled title="请先启用 Agent"' : ''}>配置入站</button><button class="btn" onclick="configureAgentRelay(${actionId})" ${configurationDisabled ? 'disabled title="请先启用 Agent"' : ''}>新建中转</button><button class="btn" onclick="showAgentDetails(${actionId})">查看详情</button><details class="agent-more"><summary>更多操作 ···</summary><div class="agent-more-menu"><button onclick="editAgent(${actionId})">编辑机器信息</button><button onclick="showAgentBootstrap(${actionId})">查看部署命令</button><button onclick="requestAgentUpdate(${actionId})" ${onlineActionsDisabled || pending ? 'disabled' : ''}>一键更新 Agent</button><button onclick="requestAgentXrayInstall(${actionId})" ${onlineActionsDisabled || pending ? 'disabled' : ''}>安装 / 更新 Xray</button><button onclick="toggleAgent(${actionId})">${disablePending ? '取消停用并启用' : status === 'disabled' ? '启用 Agent' : '停用 Agent'}</button><button onclick="rotateAgentToken(${actionId})">轮换访问令牌</button><button class="danger" onclick="deleteAgent(${actionId})">删除 Agent</button></div></details></div></article>`;
  }).join('') : `<article class="empty-operation"><b>◉</b><strong>${agents.length ? '没有符合筛选条件的 Agent' : '还没有边缘 Agent'}</strong><p>${agents.length ? '调整搜索关键词或状态筛选后重试。' : '添加第一台机器后即可集中查看健康、版本和承载资源。'}</p>${agents.length ? '' : '<button class="primary" type="button" onclick="document.querySelector(\'#newAgent\').click()">添加 Agent</button>'}</article>`;
  document.querySelectorAll('#agentCards .agent-more').forEach(details => details.addEventListener('toggle', () => positionAgentMenu(details)));
}
function positionAgentMenu(details) {
  const menu = details.querySelector('.agent-more-menu'); if (!menu) return;
  if (!details.open) { details.classList.remove('open-up'); menu.style.maxHeight = ''; return; }
  requestAnimationFrame(() => { const trigger = details.querySelector('summary')?.getBoundingClientRect(); if (!trigger) return; const below = Math.max(0, innerHeight - trigger.bottom - 12), above = Math.max(0, trigger.top - 12), openUp = below < Math.min(menu.scrollHeight, 260) && above > below; details.classList.toggle('open-up', openUp); menu.style.maxHeight = `${Math.max(80, Math.floor(openUp ? above : below))}px`; });
}
function showDeployment(deployment, title = '部署 Agent') {
  if (!deployment?.command) return;
  $('#agentBootstrapTitle').textContent = title; $('#agentCommand').textContent = deployment.command; openDialog($('#agentBootstrapModal'), '#copyAgentCommand');
}function resetImportedInboundEditor() {
  const form = $('#inboundForm'), select = $('#inboundProtocol');
  form?.removeAttribute('data-imported'); select?.removeAttribute('title'); select?.querySelector('option[data-imported-protocol]')?.remove();
}function applyInboundTemplate(reset = false) {
  const form = $('#inboundForm'); const protocol = $('#inboundProtocol').value; const template = inboundTemplates[protocol] || inboundTemplates['VLESS + Reality'];
  $('#templateName').textContent = template.name; $('#templateDesc').textContent = template.desc;
  form.querySelectorAll('[data-template]').forEach(label => {
    const visible = label.dataset.template.split(' ').includes(template.key); label.classList.toggle('template-hidden', !visible);
    const control = label.querySelector('input,select'); if (control) control.disabled = !visible;
  });
  Object.entries(template.defaults).forEach(([name, value]) => { const control = form.elements[name]; if (control && (reset || !control.value || control.dataset.auto === '1')) { control.value = value; control.dataset.auto = '1'; } });
}
function populateInboundAgents(selected = '') {
  const select = $('#inboundAgent'); if (!select) return;
  const selectedId = String(selected || ''); const current = agents.find(agent => agent.id === selectedId);
  const options = agents.filter(agent => agent.status !== 'disabled' || agent.id === selectedId).map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)} · ${agent.status === 'disabled' ? '已停用（当前绑定）' : agent.xrayAvailable ? 'Xray 可用' : '缺少 Xray'}</option>`).join('');
  const missing = selectedId && !current ? `<option value="${esc(selectedId)}">未知 Agent ${esc(selectedId)} · 当前绑定</option>` : '';
  select.innerHTML = '<option value="">本机面板 Xray</option>' + missing + options; select.value = selectedId;
  select.dataset.initialAgentId = selectedId; select.dataset.initialAgentDisabled = String(Boolean(selectedId && (!current || current.status === 'disabled')));
}
function renderInbounds() {
  $('#inboundCards').innerHTML = inbounds.length ? inbounds.map(inbound => { const state = inbound.status || 'stopped', desired = inboundDesiredState(inbound); const stateText = inboundStateText(state); const executor = inbound.agentId ? `Agent · ${inbound.agentName || inbound.agentId}` : '本机 Xray'; return `<article class="node-card"><div class="inbound-title"><b>◈</b><div><strong>${esc(inbound.name)}</strong><small>${esc(inbound.template || inbound.protocol || inbound.protocolCode)} · ${esc(executor)}</small></div></div><div class="inbound-meta"><b>${zh.listen}</b>${esc(inbound.port)}</div><div class="inbound-meta"><b>${zh.server}</b>${esc(inbound.serverAddress || '-')}</div><div class="status ${esc(state)}">${stateText}<br><small title="${esc(inbound.lastError || '')}">${esc(inbound.lastError || `${zh.security}: ${inbound.security}`)}</small></div><div class="node-link wide"><b>${zh.link}</b><code>${esc(inbound.shareLink || '')}</code></div><div class="inbound-meta wide"><b>${zh.remark}</b>${esc(inbound.remark || zh.noRemark)}</div><details class="node-json wide"><summary>Xray JSON</summary><pre>${esc(JSON.stringify(inbound.xray || {}, null, 2))}</pre></details><div class="inbound-actions wide"><button class="btn" onclick="editInbound(${inbound.id})">编辑</button><button class="btn" onclick="showInboundQr(${inbound.id})">二维码</button><button class="btn" onclick="diagnoseInbound(${inbound.id})">修复并诊断</button><button class="btn" onclick="copyInbound(${inbound.id}, 'shareLink')">${zh.copyLink}</button><button class="btn" onclick="copyInbound(${inbound.id}, 'xray')">${zh.copyJson}</button><button class="btn" onclick="toggleInbound(${inbound.id})">${desired === 'running' ? zh.pause : zh.enable}</button><button class="btn danger" onclick="deleteInbound(${inbound.id})">${zh.del}</button></div></article>`; }).join('') : `<article>${zh.emptyInbound}</article>`;
  const running = inbounds.filter(inbound => inbound.status === 'running').length, enabled = inbounds.filter(inbound => inboundDesiredState(inbound) === 'running').length; $('#inboundCount').innerHTML = `${running} <small>在线 / ${enabled} 已启用 · 共 ${inbounds.length}</small>`;
}function populateUserInbounds() {
  const select = $('#userInbound');
  if (!select) return;
  select.innerHTML = '<option value="">仅创建用户档案</option>' + inbounds.filter(item => inboundDesiredState(item) === 'running').map(item => `<option value="${item.id}">${esc(item.name)} · ${esc(item.protocol)}</option>`).join('');
}
function renderUsers() {
  $('#userCards').innerHTML = users.length ? users.map(user => {
    const used = Number(user.usedGB || 0), limit = Number(user.limitGB || 0), percent = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0, expired = user.expire && new Date(`${user.expire}T23:59:59.999`) < new Date();
    return `<article><div class="user-main"><b>◎</b><div><strong>${esc(user.name)}</strong><small>${esc(user.email)}</small>${user.access?.[0] ? `<small class="access-label">已绑定：${esc(user.access[0].protocol)}</small>` : ''}</div></div><div class="quota"><span><i style="width:${percent}%"></i></span><small>${formatGB(used)} / ${formatGB(limit)} GB</small></div><div class="status ${esc(user.status)}">${expired ? '已到期' : user.status === 'running' ? zh.run : zh.stop}<br><small>${esc(user.expire || '长期有效')}</small></div><div class="inbound-actions">${user.access?.[0]?.link ? `<button class="btn" onclick="copyUserLink(${user.id})">节点链接</button>` : ''}<button class="btn" onclick="editUser(${user.id})">编辑</button><button class="btn" onclick="toggleUser(${user.id})">${user.status === 'running' ? zh.pause : expired ? '更新到期日' : zh.enable}</button><button class="btn danger" onclick="deleteUser(${user.id})">${zh.del}</button></div></article>`;
  }).join('') : `<article>${zh.emptyUser}</article>`;
  $('#userCount').textContent = users.filter(user => user.status === 'running').length;
}
function formatGB(value) { return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 3 }); }
function renderTraffic() {
  if (!traffic) return;
  const summary = traffic.summary; $('#trafficTotal').innerHTML = `${formatGB(summary.totalGB)} <small>GB</small>`; $('#trafficRecorded').innerHTML = `${formatGB(summary.recordedGB)} <small>GB</small>`; $('#trafficActive').textContent = summary.activeUsers; $('#trafficRecords').textContent = summary.totalRecords;
  const overviewTraffic = $('#overviewTraffic'), overviewNote = $('#overviewTrafficNote'), overviewChart = $('#overviewChart'), todayTraffic = Number(traffic.daily[traffic.daily.length - 1]?.gb || 0);
  if (overviewTraffic) overviewTraffic.innerHTML = `${formatGB(todayTraffic)} <small>GB</small>`;
  if (overviewNote) overviewNote.textContent = summary.totalRecords ? `累计 ${summary.totalRecords} 条记录` : '暂无流量记录';
  if (overviewChart) {
    const activeDays = traffic.daily.filter(item => Number(item.gb) > 0);
    overviewChart.innerHTML = activeDays.length ? activeDays.map(item => `<span>${esc(item.day)}：<b>${formatGB(item.gb)} GB</b></span>`).join('　') : '<p class="empty-state">暂无流量数据。</p>';
  }
  const maximum = Math.max(1, ...traffic.daily.map(item => item.gb));
  $('#trafficDays').innerHTML = traffic.daily.map(item => `<div><span title="${esc(item.day)}：${formatGB(item.gb)} GB"><i style="height:${Math.max(5, item.gb / maximum * 100)}%"></i></span><small>${esc(item.day.slice(5))}</small><b>${formatGB(item.gb)}</b></div>`).join('');
  $('#trafficInbounds').innerHTML = traffic.inbounds.length ? traffic.inbounds.map(item => `<div class="usage-row"><div><strong>${esc(item.name)}</strong><small>${esc(item.protocol)}</small></div><b>${formatGB(item.gb)} GB</b></div>`).join('') : '<p class="empty-state">暂无入站流量记录。</p>';
  $('#trafficUsers').innerHTML = traffic.users.length ? traffic.users.map(item => { const percent = item.limitGB ? Math.min(100, item.usedGB / item.limitGB * 100) : 0; return `<div class="traffic-user"><div><strong>${esc(item.name)}</strong><small>${esc(item.email)} · ${item.status === 'running' ? '可用' : '已暂停'}</small></div><div class="quota"><span><i style="width:${percent}%"></i></span><small>${formatGB(item.usedGB)} / ${formatGB(item.limitGB)} GB</small></div></div>`; }).join('') : '<p class="empty-state">暂无用户。</p>';
  $('#trafficLog').innerHTML = traffic.records.length ? traffic.records.map(item => `<div class="traffic-log"><div><strong>${esc(item.userName)}</strong><small>${esc(item.inboundName)} · ${item.direction === 'upload' ? '上传' : '下载'} · ${new Date(item.at).toLocaleString('zh-CN')}</small></div><b>${formatGB(item.gb)} GB</b></div>`).join('') : '<p class="empty-state">暂无记录。点击“记录流量”开始统计。</p>';
}
function populateTrafficOptions() {
  const userSelect = $('#trafficUser'), inboundSelect = $('#trafficInbound');
  userSelect.innerHTML = users.filter(item => item.status === 'running').map(item => `<option value="${item.id}">${esc(item.name)} · ${esc(item.email)}</option>`).join('') || '<option value="">没有可用用户</option>';
  inboundSelect.innerHTML = '<option value="">未指定入站</option>' + inbounds.filter(item => inboundDesiredState(item) === 'running').map(item => `<option value="${item.id}">${esc(item.name)} · ${esc(item.protocol)}</option>`).join('');
}function auditResourceLabel(entry) {
  if (entry.action === 'auth.login') return '管理员登录'; if (entry.action === 'auth.logout') return '退出登录';
  const section = String(entry.resource || '').split('/')[2] || 'system'; const labels = { relays: '中转规则', inbounds: '入站节点', users: '用户', agents: 'Agent', traffic: '流量', runtime: 'Xray Core', system: '系统设置' };
  return `${entry.method || ''} ${labels[section] || section}`.trim();
}
function renderAudit() {
  const target = $('#auditLog'); if (!target) return;
  target.innerHTML = auditEntries.length ? auditEntries.map(entry => `<div class="audit-row"><div><strong>${esc(new Date(entry.at).toLocaleString('zh-CN'))}</strong><small>${esc(entry.ip || 'unknown')} · ${esc(entry.actor || 'unknown')}</small></div><div><strong>${esc(auditResourceLabel(entry))}</strong><small>${esc(entry.resource || '')}${entry.status ? ` · HTTP ${Number(entry.status)}` : ''}</small></div><span class="audit-outcome ${esc(entry.outcome || '')}">${entry.outcome === 'success' ? '成功' : entry.outcome === 'blocked' ? '已阻止' : '已拒绝'}</span></div>`).join('') : '<p class="empty-state">暂无管理员操作记录。</p>';
}function renderSystem() {
  if (!systemInfo) return;
  $('#adminName').textContent = systemInfo.admin.username;
  const security = systemInfo.security || {}, insecureAgentCount = agents.filter(agent => agent.controllerSecure === false).length; const checks = [
    { ok: !security.defaultPassword && !security.mustChangePassword, name: '管理员密码', detail: security.defaultPassword ? '仍在使用历史默认密码' : security.mustChangePassword ? '一次性初始凭据尚未完成修改' : '已完成首次凭据修改' },
    { ok: security.transportSecure, name: 'HTTPS 传输', detail: security.transportSecure ? '当前请求经 HTTPS 保护' : '当前面板仍通过 HTTP 访问' },
    { ok: security.secureCookie, name: '安全会话 Cookie', detail: security.secureCookie ? 'Secure Cookie 已启用' : '请设置 SECURE_COOKIE=true' },
    { ok: auditAvailable, name: '操作审计', detail: auditAvailable ? `已记录 ${Number(security.auditEntries || 0)} 条事件` : '审计记录接口暂时不可用' },
    { ok: insecureAgentCount === 0, name: 'Agent 控制链路', detail: insecureAgentCount ? `${insecureAgentCount} 台 Agent 仍使用远程 HTTP，请迁移到 HTTPS` : '远程 Agent 均使用 HTTPS，本机回环可使用 HTTP' }
  ];
  const score = checks.filter(item => item.ok).length, total = checks.length; const grade = $('#securityGrade'); grade.textContent = `${score}/${total}`; grade.className = `security-grade ${score === total ? 'good' : 'warn'}`;
  $('#securitySummary').textContent = score === total ? '关键安全控制项已全部启用。' : `仍有 ${total - score} 项商用部署基线需要处理。`;
  $('#securityChecks').innerHTML = checks.map(item => `<div class="security-check ${item.ok ? 'good' : ''}"><i></i><div><strong>${esc(item.name)}</strong><small>${esc(item.detail)}</small></div></div>`).join('');
  const tls = systemInfo.tls;
  $('#tlsDomain').value = tls.domain || ''; $('#tlsEmail').value = tls.email || ''; $('#certPath').value = tls.certPath || ''; $('#keyPath').value = tls.keyPath || '';
  $('#tlsSummary').textContent = tls.ready ? `证书已就绪：${tls.domain}（重启后启用 HTTPS）` : tls.error ? `证书异常：${tls.error}` : tls.domain ? `已保存 ${tls.domain} 的配置，尚未检测到可用证书文件。` : '尚未配置证书。';
  const status = $('#certStatus'); status.textContent = tls.ready ? '证书就绪' : tls.error ? '证书异常' : systemInfo.certbotAvailable ? '可申请证书' : '需要 certbot'; status.className = `cert-status ${tls.ready ? 'ready' : tls.error ? 'error' : ''}`;
  const runtime = systemInfo.runtime || {}; const coreText = runtime.running ? `Core 运行中（PID ${runtime.pid}）` : runtime.available ? 'Core 已检测到，尚未启动' : '未检测到 Xray Core';
  $('#runtimeSummary').textContent = coreText; $('#runtimeDetail').textContent = runtime.running ? `已监听 ${runtime.enabledInbounds} 个已启用入站` : (runtime.lastError || (runtime.available ? `版本：${runtime.version || '未知'}；已启用入站：${runtime.enabledInbounds}` : '安装 Xray Core 后可由面板生成配置并启动。'));
  $('#runtimeVersion').textContent = runtime.installedVersion || '未安装';
  const network = systemInfo.network || {}; $('#publicAddress').textContent = network.publicAddress || '未识别'; $('#publicAddressDetail').textContent = network.publicAddress ? `来源：${network.source} · ${network.checkedAt ? new Date(network.checkedAt).toLocaleString('zh-CN') : ''}` : (network.checking ? '正在检测 VPS 公网地址…' : (network.error || '可在此重新检测，或设置环境变量 PUBLIC_ADDRESS。')); $('#detectAddress').disabled = Boolean(network.checking);
  if (!$('#coreVersion').value && runtime.installedVersion) $('#coreVersion').placeholder = `当前 ${runtime.installedVersion}；留空安装最新`;
  $('#installCore').disabled = runtime.installing || runtime.running; $('#installCore').textContent = runtime.installing ? '正在安装…' : runtime.available ? '切换 / 更新 Core' : '一键安装 Core';
  $('#startRuntime').disabled = !runtime.available || runtime.running; $('#startRuntime').title = runtime.enabledInbounds ? '' : '当前没有启用的入站；仍可先启动 Core，新增入站后会自动重载。'; $('#stopRuntime').disabled = !runtime.running;
}
async function load() {
  setOperationsSync('loading', '正在同步运营数据…');
  const results = await Promise.allSettled([api('/api/relays'), api('/api/inbounds'), api('/api/users'), api('/api/agents'), api('/api/traffic'), api('/api/system'), api('/api/system/audit')]);
  if (results.some(result => result.status === 'rejected' && result.reason?.status === 401)) return;
  const [relayResult, inboundResult, userResult, agentResult, trafficResult, systemResult, auditResult] = results;
  if (relayResult.status === 'fulfilled') relays = relayResult.value; else console.error(relayResult.reason);
  if (inboundResult.status === 'fulfilled') inbounds = inboundResult.value; else console.error(inboundResult.reason);
  if (userResult.status === 'fulfilled') users = userResult.value; else console.error(userResult.reason);
  if (agentResult.status === 'fulfilled') agents = agentResult.value; else console.error(agentResult.reason);
  if (trafficResult.status === 'fulfilled') traffic = trafficResult.value; else console.error(trafficResult.reason);
  if (relayResult.status === 'fulfilled' || relays.length) renderRelays(); else $('#cards').innerHTML = `<article class="empty-operation"><strong>${zh.apiFailed}</strong><p>中转数据暂时不可用，请稍后刷新。</p></article>`;
  if (inboundResult.status === 'fulfilled' || inbounds.length) renderInbounds(); else $('#inboundCards').innerHTML = `<article>${zh.apiFailed}</article>`;
  if (userResult.status === 'fulfilled' || users.length) renderUsers(); else $('#userCards').innerHTML = `<article>${zh.apiFailed}</article>`;
  if (agentResult.status === 'fulfilled' || agents.length) renderAgents(); else $('#agentCards').innerHTML = `<article class="empty-operation"><strong>${zh.apiFailed}</strong><p>Agent 数据暂时不可用，请稍后刷新。</p></article>`;
  if (trafficResult.status === 'fulfilled' && traffic) renderTraffic();
  auditAvailable = auditResult.status === 'fulfilled';
  if (systemResult.status === 'fulfilled') { systemInfo = systemResult.value; renderSystem(); }
  else {
    systemInfo = null; console.error(systemResult.reason); $('#securitySummary').textContent = '安全状态暂时不可用。'; $('#securityGrade').textContent = '--'; $('#securityGrade').className = 'security-grade warn'; $('#securityChecks').innerHTML = `<p class="empty-state">${zh.apiFailed}</p>`; $('#tlsSummary').textContent = '证书状态暂时不可用。'; $('#runtimeSummary').textContent = 'Xray 运行状态暂时不可用。';
  }
  if (auditResult.status === 'fulfilled') { auditEntries = auditResult.value.entries || []; renderAudit(); }
  else { auditEntries = []; console.error(auditResult.reason); $('#auditLog').innerHTML = '<p class="empty-state">审计记录暂时不可用，其他管理功能不受影响。</p>'; }
  const liveFailures = [relayResult, inboundResult, agentResult].filter(result => result.status === 'rejected');
  if (!liveFailures.length) { lastOperationsSyncAt = new Date(); setOperationsSync('live'); }
  else setOperationsSync('error', `部分数据同步失败（${liveFailures.length} 项）`);
}
function operationsInteractionActive() {
  const active = document.activeElement; const listFocused = Boolean(active?.closest?.('#cards, #agentCards, #relayBatchBar'));
  return listFocused || Boolean(document.querySelector('#agentCards details[open]'));
}
function autoOperationsRefreshBlocked() { return fleetUpdateInProgress || operationsInteractionActive(); }
async function refreshOperations(manual = false) {
  if (applicationLocked) return;
  if (!manual && autoOperationsRefreshBlocked()) { if (!fleetUpdateInProgress) setOperationsSync('', '正在操作，自动刷新已延后'); return; }
  if (operationsRefreshPromise) return operationsRefreshPromise;
  setOperationsSync('loading', '正在刷新实时状态…');
  operationsRefreshPromise = (async () => {
    const results = await Promise.allSettled([api('/api/relays'), api('/api/inbounds'), api('/api/agents')]);
    if (results.some(result => result.status === 'rejected' && result.reason?.status === 401)) return;
    const [relayResult, inboundResult, agentResult] = results; const failures = results.filter(result => result.status === 'rejected');
    if (!manual && autoOperationsRefreshBlocked()) { if (!fleetUpdateInProgress) setOperationsSync('', '正在操作，自动刷新已延后'); return; }
    if (relayResult.status === 'fulfilled') relays = relayResult.value;
    if (inboundResult.status === 'fulfilled') inbounds = inboundResult.value;
    if (agentResult.status === 'fulfilled') agents = agentResult.value;
    renderRelays(); renderInbounds(); renderAgents();
    if (!failures.length) { lastOperationsSyncAt = new Date(); setOperationsSync('live'); if (manual) toast('实时状态已刷新。', 'success'); }
    else {
      setOperationsSync('error', `同步失败（${failures.length} 项）`); failures.forEach(result => console.error(result.reason));
      if (manual || Date.now() - refreshFailureNotifiedAt > 60000) { toast('部分实时状态同步失败，已保留上次数据。', 'error'); refreshFailureNotifiedAt = Date.now(); }
    }
  })();
  try { return await operationsRefreshPromise; } finally { operationsRefreshPromise = null; }
}
async function patchStatus(type, id, status) { await api(`/api/${type}/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
async function copyText(value) {
  const text = String(value || ''); if (!text) throw new Error('没有可复制的内容');
  if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); alert(zh.copied); return; } catch {} }
  const textarea = document.createElement('textarea'); textarea.value = text; textarea.setAttribute('readonly', ''); textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'; document.body.appendChild(textarea); textarea.select(); textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand('copy'); textarea.remove(); if (!copied) throw new Error('浏览器拒绝复制权限'); alert(zh.copied);
}
window.editInbound = id => {
  const inbound = inbounds.find(item => item.id === id); if (!inbound) return;
  editingInboundId = id; const form = $('#inboundForm'); resetImportedInboundEditor(); form.reset(); populateInboundAgents(inbound.agentId || '');
  const protocolSelect = $('#inboundProtocol'), imported = /^3x-ui(?:\s|$)/i.test(String(inbound.template || ''));
  if (imported) {
    const option = document.createElement('option'); option.value = '__imported__'; option.textContent = `${inbound.protocol || inbound.protocolCode || '原始协议'}（3x-ui 导入，只读）`; option.dataset.importedProtocol = 'true'; protocolSelect.appendChild(option); protocolSelect.value = option.value; protocolSelect.title = '导入节点保留原始协议、客户端和传输配置'; form.dataset.imported = 'true';
    form.querySelectorAll('[data-template]').forEach(label => { label.classList.add('template-hidden'); const control = label.querySelector('input,select'); if (control) control.disabled = true; });
    $('#templateName').textContent = inbound.template || '3x-ui 兼容导入'; $('#templateDesc').textContent = '保留原始协议、客户端、传输与安全字段；此处仅修改名称、端口、连接地址、执行节点和备注。';
  } else { protocolSelect.value = inbound.protocol; applyInboundTemplate(true); }
  const stream = inbound.streamSettings || {}, reality = stream.realitySettings || {}, realityMeta = reality.settings || {}, client = inbound.settings?.clients?.[0] || {}, ws = stream.wsSettings || {}, grpc = stream.grpcSettings || {}, certificate = stream.tlsSettings?.certificates?.[0] || {};
  const values = { name: inbound.name, port: inbound.port, serverAddress: inbound.serverAddress, sni: reality.serverNames?.[0] || stream.tlsSettings?.serverName || '', certPath: certificate.certificateFile || '', keyPath: certificate.keyFile || '', dest: reality.dest || '', fingerprint: realityMeta.fingerprint || 'chrome', flow: client.flow || 'xtls-rprx-vision', email: client.email || '', path: ws.path || '/vless', host: ws.headers?.Host || '', serviceName: grpc.serviceName || 'vless-grpc', method: inbound.settings?.method || '2022-blake3-aes-128-gcm', remark: inbound.remark || '' };
  Object.entries(values).forEach(([name, value]) => { if (form.elements[name]) form.elements[name].value = value; }); $('#inboundAgent').value = inbound.agentId || ''; $('#inboundProtocol').disabled = true;
  $('#inboundModalTitle').textContent = '编辑入站节点'; $('#inboundSubmit').textContent = '保存修改'; openDialog($('#inboundModal'));
};window.showInboundQr = id => { const inbound = inbounds.find(item => item.id === id); if (!inbound) return; $('#qrTitle').textContent = `${inbound.name} · 节点二维码`; $('#qrImage').src = `/api/inbounds/${id}/qr?t=${Date.now()}`; openDialog($('#qrModal'), '#qrTitle'); };window.copyInbound = async (id, field) => { const inbound = inbounds.find(item => item.id === id); if (!inbound) return; const value = field === 'xray' ? JSON.stringify(inbound.xray || {}, null, 2) : inbound.shareLink; try { await copyText(value || ''); } catch { prompt(field === 'xray' ? zh.copyJson : zh.copyLink, value || ''); } };
function showDiagnostics(reports, title = '线路诊断报告') {
  const normalized = reports.map(item => ({ name: item.name || '未命名线路', report: item.report || { ok: false, checks: [{ status: 'error', name: '诊断失败', detail: item.error || '未知错误' }] } }));
  diagnosticsText = normalized.map(item => {
    const checks = item.report.checks || []; return `${item.name}：${item.report.ok ? '通过' : '需要处理'}\n${checks.map(check => `${check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : '✗'} ${check.name}：${check.detail}`).join('\n')}`;
  }).join('\n\n');
  $('#diagnosticsTitle').textContent = title; $('#diagnosticsBody').innerHTML = normalized.map(item => {
    const checks = item.report.checks || []; return `<section class="diagnostic-group"><header><strong>${esc(item.name)}</strong><span class="${item.report.ok ? 'ok' : 'error'}">${item.report.ok ? '检查通过' : '需要处理'}</span></header>${checks.map(check => `<div class="diagnostic-check ${esc(check.status)}"><i>${check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : '×'}</i><strong>${esc(check.name)}</strong><small>${esc(check.detail)}</small></div>`).join('')}</section>`;
  }).join('') || '<p class="empty-state">没有可显示的诊断结果。</p>';
  openDialog($('#diagnosticsModal'), '#diagnosticsTitle');
}
window.configureAgentInbound = id => {
  const agent = agents.find(item => item.id === id); if (!agent) return; if (agent.status === 'disabled') return toast('请先启用该 Agent，再创建入站。', 'error'); editingInboundId = null; const form = $('#inboundForm'); form.reset(); $('#inboundProtocol').disabled = false; $('#inboundModalTitle').textContent = `在 ${agent.name} 创建入站`; $('#inboundSubmit').textContent = '生成节点'; populateInboundAgents(id); applyInboundTemplate(true); const address = form.elements.serverAddress; if (address && !address.value) address.value = agent.addresses?.[0] || ''; openDialog($('#inboundModal'));
};
window.configureAgentRelay = id => {
  const agent = agents.find(item => item.id === id); if (!agent) return; if (agent.status === 'disabled') return toast('请先启用该 Agent，再创建中转。', 'error'); editingRelayId = null; const form = $('#form'); form.reset(); form.elements.bindAddress.value = '0.0.0.0'; populateRelayAgents(id); $('#relayModalEyebrow').textContent = 'EDGE RELAY'; $('#relayModalTitle').textContent = `在 ${agent.name} 创建中转`; $('#relaySubmit').textContent = '创建并启用'; openDialog($('#modal'));
};
window.showAgentDetails = id => {
  const agent = agents.find(item => item.id === id); if (!agent) return; const seconds = Number(agent.uptimeSeconds || 0), uptime = seconds ? `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分` : '-'; const memory = agent.memoryTotal ? `${formatBytes(agent.memoryTotal - Number(agent.memoryFree || 0))} / ${formatBytes(agent.memoryTotal)}` : '-';
  const assignedInbounds = inbounds.filter(item => item.agentId === agent.id), assignedRelays = relays.filter(item => item.agentId === agent.id);
  const rows = [['机器 ID', agent.id], ['数据新鲜度', formatRelativeTime(agent.lastSeenAt)], ['控制地址', agent.controllerUrl], ['控制链路', agent.controllerSecure === false ? '不安全：请迁移到 HTTPS' : 'HTTPS / 本机回环 HTTP'], ['在线状态', agentStateText(agent)], ['Agent 更新', agent.updatePending ? '更新下发中' : agent.updateError || (agent.lastUpdatedAt ? `已更新：${new Date(agent.lastUpdatedAt).toLocaleString('zh-CN')}` : '-')], ['最近维护撤销', agent.maintenanceCancelledAt ? `${agent.maintenanceCancelledReason || '维护任务已撤销'} · ${new Date(agent.maintenanceCancelledAt).toLocaleString('zh-CN')}` : '-'], ['Xray Core', agent.xrayAvailable ? agent.xrayVersion || '可用' : '未检测到'], ['Xray 安装状态', agent.xrayInstallPending || agent.xrayInstalling ? '安装中' : agent.xrayInstallError || (agent.xrayInstalledAt ? `已安装：${new Date(agent.xrayInstalledAt).toLocaleString('zh-CN')}` : '-')], ['主机名', agent.hostname || '-'], ['系统', agent.platform || '-'], ['架构', agent.arch || '-'], ['网卡地址', (agent.addresses || []).join(', ') || '-'], ['CPU 逻辑核', agent.cpus || '-'], ['内存（已用 / 总量）', memory], ['系统运行时长', uptime], ['Agent PID', agent.processId || '-'], ['Agent 启动时间', agent.agentStartedAt ? new Date(agent.agentStartedAt).toLocaleString('zh-CN') : '-'], ['Node.js', agent.nodeVersion || '-'], ['Agent 版本', agent.version || '-'], ['首次登记', agent.createdAt ? new Date(agent.createdAt).toLocaleString('zh-CN') : '-'], ['最后心跳', agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString('zh-CN') : '-']];
  const inboundRows = assignedInbounds.length ? assignedInbounds.map(item => `<li><b>${esc(item.name)}</b> · 期望 ${desiredStateText(item.desiredStatus || item.status)} · 实际 ${inboundStateText(item.status)}${item.lastError ? `<small>${esc(item.lastError)}</small>` : ''}</li>`).join('') : '<li>尚未分配入站。</li>';
  const relayRows = assignedRelays.length ? assignedRelays.map(item => { const state = relayState(item); return `<li><b>${esc(item.name)}</b> · 期望 ${desiredStateText(item.status)} · 实际 ${esc(relayStateText(state, item))} · 连接 ${Number(item.connections || 0)} · ↑${formatBytes(item.bytesIn)} ↓${formatBytes(item.bytesOut)}${item.lastError ? `<small>${esc(item.lastError)}</small>` : ''}</li>`; }).join('') : '<li>尚未分配中转。</li>';
  $('#agentDetailsTitle').textContent = `${agent.name} · Agent 详情`; $('#agentDetailsBody').innerHTML = `<div class="agent-detail-grid">${rows.map(([key, value]) => `<div><small>${esc(key)}</small><strong title="${esc(value || '-')}">${esc(value || '-')}</strong></div>`).join('')}</div><h3>分配的入站（期望 / 实际）</h3><ul class="agent-relay-list">${inboundRows}</ul><h3>分配的中转（期望 / 实际）</h3><ul class="agent-relay-list">${relayRows}</ul>`; openDialog($('#agentDetailsModal'), '#agentDetailsTitle');
};
window.showAgentBootstrap = async id => { try { const deployment = await api(`/api/agents/${encodeURIComponent(id)}/bootstrap`); showDeployment(deployment, '部署 Agent'); } catch (error) { toast(error.message, 'error'); } };
window.editAgent = id => {
  const agent = agents.find(item => item.id === id); if (!agent) return; const form = $('#agentEditForm'); form.reset(); form.elements.id.value = agent.id; form.elements.name.value = agent.name; form.elements.controllerUrl.value = agent.controllerUrl || ''; $('#agentEditTitle').textContent = `编辑 ${agent.name}`; openDialog($('#agentEditModal'));
};
window.editAgentController = window.editAgent;
window.toggleAgent = async id => {
  const agent = agents.find(item => item.id === id); if (!agent) return; const disabling = agent.status !== 'disabled';
  const maintenance = agentMaintenanceActive(agent);
  if (disabling && !confirm(maintenance ? `停用 ${agent.name} 将撤销尚未确认的维护任务；已开始的安装可能完成后才停止全部工作负载。确定继续吗？` : `停用 ${agent.name} 后将停止接收配置，并在下次心跳撤销其所有转发。确定继续吗？`)) return;
  try { const response = await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !disabling }) }); const cancellation = response?.agent?.maintenanceCancelledReason; toast(disabling ? `${cancellation ? `${cancellation}；` : ''}等待 Agent 心跳确认工作负载已停止。` : 'Agent 已启用，等待下一次心跳。', 'success'); await load(); } catch (error) { toast(error.message, 'error'); }
};
window.requestAgentXrayInstall = async id => {
  const agent = agents.find(item => item.id === id); if (!agent || agentMaintenanceActive(agent) || agent.status !== 'online') return; if (!confirm(`向 ${agent.name} 下发 Xray Core 安装？安装期间节点任务可能短暂不可用。`)) return;
  try { const response = await api(`/api/agents/${encodeURIComponent(id)}/xray/install`, { method: 'POST', body: '{}' }); toast(response.message || 'Xray 安装任务已下发。', 'success'); await load(); } catch (error) { toast(error.message, 'error'); }
};
window.requestAgentUpdate = async id => {
  const agent = agents.find(item => item.id === id); if (!agent || agentMaintenanceActive(agent) || agent.status !== 'online') return; if (!confirm(`向 ${agent.name} 下发 Agent 更新？更新后 systemd 会重启服务。`)) return;
  try { const response = await api(`/api/agents/${encodeURIComponent(id)}/update`, { method: 'POST', body: '{}' }); toast(response.message || '更新任务已下发。', 'success'); await load(); } catch (error) { toast(error.message, 'error'); }
};
window.rotateAgentToken = async id => {
  const agent = agents.find(item => item.id === id); if (!agent || !confirm(`轮换 ${agent.name} 的令牌后，旧 Agent 会在下次心跳立即停止服务。必须重新执行部署命令才能恢复，确定继续吗？`)) return;
  try { const response = await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ rotateToken: true }) }); showDeployment(response.deployment, '令牌已轮换：请立即重新部署'); await load(); } catch (error) { toast(error.message, 'error'); }
};
window.deleteAgent = async id => {
  const agent = agents.find(item => item.id === id); if (!agent || !confirm(`永久删除 ${agent.name}？令牌会立即失效；远端服务需要另行卸载。`)) return;
  try { await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Agent 已删除。', 'success'); await load(); } catch (error) { toast(error.message, 'error'); }
};
window.toggleRelay = async id => { const item = relays.find(value => value.id === id); if (!item || relayState(item) === 'stopping') return; try { const stopping = item.status === 'running'; const response = await api(`/api/relays/${id}`, { method: 'PATCH', body: JSON.stringify({ status: stopping ? 'stopped' : 'running' }) }); await load(); toast(stopping && response?.pendingRemote ? '停止请求已下发，等待 Agent 确认。' : stopping ? '中转已暂停。' : '中转已启用。', 'success'); } catch (error) { toast(error.message, 'error'); } };
window.editRelay = id => {
  const relay = relays.find(item => item.id === id); if (!relay || ['legacy', 'stopping'].includes(relayState(relay))) return; editingRelayId = id; const form = $('#form'); form.reset(); populateRelayAgents(relay.agentId || ''); Object.entries({ name: relay.name, transport: relay.transport, listenPort: relay.listenPort, bindAddress: relay.bindAddress, agentId: relay.agentId || '', targetHost: relay.targetHost, targetPort: relay.targetPort, entry: relay.entry || '', exit: relay.exit || '' }).forEach(([name, value]) => { if (form.elements[name]) form.elements[name].value = value; }); $('#relayModalEyebrow').textContent = 'EDIT RELAY'; $('#relayModalTitle').textContent = `编辑中转：${relay.name}`; $('#relaySubmit').textContent = '验证、保存并重载'; openDialog($('#modal'));
};
window.diagnoseRelay = async id => {
  const relay = relays.find(item => item.id === id); if (!relay) return;
  try { const report = await api(`/api/relays/${id}/diagnose`, { method: 'POST', body: '{}' }); showDiagnostics([{ name: relay.name, report }]); await refreshOperations(); } catch (error) { showDiagnostics([{ name: relay.name, error: error.message }]); }
};
window.deleteRelay = async id => {
  const relay = relays.find(item => item.id === id); if (!relay || relayState(relay) === 'stopping' || !confirm(`删除中转“${relay.name}”？${relay.agentId ? '请求将在 Agent 心跳后执行；确认前规则仍保留且可能继续转发。' : '本机现有连接会立即断开。'}`)) return;
  try { const response = await api(`/api/relays/${id}`, { method: 'DELETE' }); if (!response?.pending) selectedRelayIds.delete(Number(id)); toast(response?.pending ? '删除请求已下发，等待 Agent 确认后移除规则。' : '中转规则已删除。', 'success'); await load(); } catch (error) { toast(error.message, 'error'); }
};
async function runRelayBatchStatus(status) {
  const ids = [...selectedRelayIds]; if (!ids.length) return; const action = status === 'running' ? '启用' : '暂停', selected = ids.map(id => relays.find(item => item.id === id)).filter(Boolean), remoteCount = selected.filter(item => item.agentId).length; const impact = status === 'stopped' ? (remoteCount ? `本机规则会立即断开；${remoteCount} 条远程规则需等待 Agent 心跳确认。` : '本机现有连接会立即断开。') : (remoteCount ? `${remoteCount} 条远程规则需等待 Agent 应用后才算运行。` : '本机规则将在监听成功后显示运行。'); if (!confirm(`批量${action}已选择的 ${ids.length} 条中转？${impact}`)) return;
  const reports = []; for (const id of ids) { const relay = relays.find(item => item.id === id); if (!relay) continue; try { const result = await api(`/api/relays/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); const actual = relayState(result || {}), failed = status === 'running' && actual === 'error', waiting = !failed && (status === 'stopped' ? Boolean(result?.pendingRemote) || actual === 'stopping' : actual !== 'running'); const detail = failed ? (result?.lastError || '启用失败，规则未运行') : waiting ? (status === 'stopped' ? '停止请求已下发，等待 Agent 确认' : `启用请求已接受，当前${relayStateText(actual, result)}`) : status === 'stopped' ? '已暂停' : '已启用并运行'; reports.push({ name: relay.name, report: { ok: !failed && !waiting, checks: [{ status: failed ? 'error' : waiting ? 'warning' : 'ok', name: '批量操作', detail }] } }); } catch (error) { reports.push({ name: relay.name, error: error.message }); } }
  selectedRelayIds.clear(); await load(); showDiagnostics(reports, `批量${action}结果`);
}
async function diagnoseSelectedRelays() {
  const ids = [...selectedRelayIds]; if (!ids.length) return; const reports = [];
  for (const id of ids) { const relay = relays.find(item => item.id === id); if (!relay) continue; try { reports.push({ name: relay.name, report: await api(`/api/relays/${id}/diagnose`, { method: 'POST', body: '{}' }) }); } catch (error) { reports.push({ name: relay.name, error: error.message }); } }
  showDiagnostics(reports, `批量诊断 · ${reports.length} 条线路`); await refreshOperations();
}
function fleetUpdateDelay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function fetchAgentFleetSnapshot() {
  const snapshot = await api('/api/agents'); agents = snapshot; return snapshot;
}
async function waitForAgentUpdate(target, before) {
  const deadline = Date.now() + 180000; let sawPending = false;
  while (Date.now() < deadline) {
    await fleetUpdateDelay(2500);
    const snapshot = await fetchAgentFleetSnapshot(); const current = snapshot.find(agent => agent.id === target.id);
    if (!current) throw new Error('Agent 已被删除或不可见');
    if (current.status === 'disabled') throw new Error('Agent 在更新期间被停用');
    sawPending = sawPending || current.updatePending;
    if (current.updateError && !current.updatePending) throw new Error(current.updateError);
    const versionChanged = String(current.version || '') !== String(before.version || '');
    const completedAtChanged = Boolean(current.lastUpdatedAt && current.lastUpdatedAt !== before.lastUpdatedAt);
    if (!current.updatePending && (sawPending || versionChanged || completedAtChanged)) return current;
  }
  throw new Error('等待 Agent 更新确认超时（180 秒）');
}
async function updateOnlineAgentFleet() {
  if (fleetUpdateInProgress) return;
  const targets = agents.filter(agent => agent.status === 'online' && !agentMaintenanceActive(agent));
  if (!targets.length) return;
  if (!confirm(`将按金丝雀顺序更新 ${targets.length} 台在线 Agent：每台确认完成后才更新下一台；遇到失败会立即停止。继续吗？`)) return;
  const button = $('#updateOnlineAgents'); let completed = 0, failed = null, currentTarget = null;
  fleetUpdateInProgress = true; button.disabled = true;
  try {
    for (const target of targets) {
      currentTarget = target; button.textContent = `更新 ${completed + 1}/${targets.length}：${target.name}`; setOperationsSync('loading', `金丝雀更新 ${completed + 1}/${targets.length} · ${target.name}`);
      const snapshot = await fetchAgentFleetSnapshot(); const before = snapshot.find(agent => agent.id === target.id);
      if (!before) throw new Error('Agent 已被删除或不可见');
      if (before.status !== 'online') throw new Error('Agent 在排队期间离线');
      if (agentMaintenanceActive(before)) throw new Error('Agent 已有维护任务，已停止后续更新');
      await api(`/api/agents/${encodeURIComponent(target.id)}/update`, { method: 'POST', body: '{}' });
      await waitForAgentUpdate(target, before); completed++;
    }
  } catch (error) {
    failed = { name: currentTarget?.name || 'Agent', message: error.message };
  } finally {
    fleetUpdateInProgress = false;
    try { await load(); } catch (error) { if (!failed) failed = { name: currentTarget?.name || '面板', message: error.message }; }
    const remaining = agents.filter(agent => agent.status === 'online' && !agentMaintenanceActive(agent)); button.disabled = remaining.length === 0; button.textContent = remaining.length ? `更新在线 Agent（${remaining.length}）` : '更新在线 Agent';
  }
  if (applicationLocked) return;
  if (failed) { setOperationsSync('error', `更新停止 · ${failed.name}`); toast(`已完成 ${completed}/${targets.length} 台；${failed.name} 失败：${failed.message}`, 'error'); }
  else toast(`已按顺序完成 ${completed} 台 Agent 更新。`, 'success');
}
window.diagnoseInbound = async id => { const item = inbounds.find(value => value.id === id); if (!item) return; try { const report = await api(`/api/inbounds/${id}/diagnose`, { method: 'POST', body: JSON.stringify({ repair: true }) }); const icon = state => state === 'ok' ? '✓' : state === 'warning' ? '!' : '✗'; alert(`${report.ok ? '诊断完成' : '发现需要处理的问题'}\n\n${report.checks.map(check => `${icon(check.status)} ${check.name}：${check.detail}`).join('\n')}`); await load(); } catch (error) { alert(error.message); } };window.toggleInbound = async id => { const item = inbounds.find(value => value.id === id); if (!item) return; try { await patchStatus('inbounds', id, inboundDesiredState(item) === 'running' ? 'stopped' : 'running'); } catch (error) { alert(error.message); } };
window.deleteInbound = async id => { if (confirm(zh.confirmInbound)) try { await api(`/api/inbounds/${id}`, { method: 'DELETE' }); await load(); } catch (error) { alert(error.message); } };
window.copyUserLink = async id => { const user = users.find(item => item.id === id); const link = user?.access?.[0]?.link; if (!link) return; try { await copyText(link); } catch { prompt('节点链接', link); } };
window.editUser = id => { const user = users.find(item => item.id === id); if (!user) return; editingUserId = id; const form = $('#userForm'); form.reset(); form.elements.name.value = user.name; form.elements.email.value = user.email; form.elements.limitGB.value = user.limitGB; form.elements.expire.value = user.expire || ''; form.elements.inboundId.value = ''; form.elements.name.disabled = true; form.elements.email.disabled = true; form.elements.inboundId.disabled = true; $('#userModalTitle').textContent = `编辑 ${user.name}`; $('#userSubmit').textContent = '保存用户设置'; openDialog($('#userModal')); };window.toggleUser = async id => { const item = users.find(value => value.id === id); if (!item) return; if (item.status !== 'running' && item.expire && new Date(`${item.expire}T23:59:59.999`) < new Date()) return window.editUser(id); try { await patchStatus('users', id, item.status === 'running' ? 'stopped' : 'running'); } catch (error) { alert(error.message); } };
window.deleteUser = async id => { if (confirm(zh.confirmUser)) try { await api(`/api/users/${id}`, { method: 'DELETE' }); await load(); } catch (error) { alert(error.message); } };
function closeSidebar() {
  $('.sidebar').classList.remove('open'); document.body.classList.remove('nav-open'); $('#menu').setAttribute('aria-expanded', 'false'); $('#menu').setAttribute('aria-label', '打开菜单'); syncApplicationAccess();
}
function activatePage(id, moveFocus = true) {
  if (!pageNames[id]) return;
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === id));
  document.querySelectorAll('.nav').forEach(nav => { const active = nav.dataset.page === id; nav.classList.toggle('active', active); if (active) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); });
  $('#crumb').innerHTML = `控制台 / <strong>${pageNames[id]}</strong>`; history.replaceState(null, '', `#${id}`); closeSidebar(); if (moveFocus) focusActivePage();
  if (['relays', 'agents'].includes(id) && !applicationLocked && (!lastOperationsSyncAt || Date.now() - lastOperationsSyncAt.getTime() > 5000)) refreshOperations();
}

document.querySelectorAll('.nav,[data-go]').forEach(link => link.onclick = event => { const id = link.dataset.page || link.dataset.go; if (!id) return; event.preventDefault(); activatePage(id); });
$('#search').oninput = renderRelays;
$('#relayExecutorFilter').onchange = renderRelays;
$('#agentSearch').oninput = renderAgents;
$('#agentStatusFilter').onchange = event => { agentFilter = event.target.value; renderAgents(); };
$('#relayRefresh').onclick = () => refreshOperations(true);
$('#agentRefresh').onclick = () => refreshOperations(true);
$('#relayBatchEnable').onclick = () => runRelayBatchStatus('running');
$('#relayBatchPause').onclick = () => runRelayBatchStatus('stopped');
$('#relayBatchDiagnose').onclick = diagnoseSelectedRelays;
$('#relayBatchClear').onclick = () => { selectedRelayIds.clear(); renderRelays(); };
$('#updateOnlineAgents').onclick = updateOnlineAgentFleet;
$('#copyDiagnostics').onclick = async () => { try { await copyText(diagnosticsText); } catch { prompt('诊断报告', diagnosticsText); } };
document.querySelectorAll('.filter').forEach(button => button.onclick = () => { filter = button.dataset.filter; document.querySelectorAll('.filter').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); renderRelays(); });
$('#newRelay').onclick = () => { editingRelayId = null; const form = $('#form'); form.reset(); form.elements.bindAddress.value = '0.0.0.0'; populateRelayAgents(); $('#relayModalEyebrow').textContent = 'NEW RELAY'; $('#relayModalTitle').textContent = '创建端口转发'; $('#relaySubmit').textContent = '创建并启用'; openDialog($('#modal')); };
$('#newAgent').onclick = () => { const form = $('#agentForm'); form.reset(); form.elements.controllerUrl.value = suggestedControllerUrl(); openDialog($('#agentModal')); };$('#import3xuiInbound').onclick = () => { const form = $('#import3xuiForm'); form.reset(); populateInboundAgents(); const select = $('#importInboundAgent'); select.innerHTML = $('#inboundAgent').innerHTML; const address = form.elements.serverAddress; if (!address.value && systemInfo?.network?.publicAddress) address.value = systemInfo.network.publicAddress; openDialog($('#import3xuiModal')); };$('#newInbound').onclick = () => { editingInboundId = null; const form = $('#inboundForm'); form.reset(); $('#inboundProtocol').disabled = false; $('#inboundModalTitle').textContent = '生成入站节点'; $('#inboundSubmit').textContent = '生成节点'; populateInboundAgents(); applyInboundTemplate(true); const address = form.elements.serverAddress; if (address && !address.value && systemInfo?.network?.publicAddress) address.value = systemInfo.network.publicAddress; openDialog($('#inboundModal')); };
$('#newUser').onclick = () => { editingUserId = null; const form = $('#userForm'); form.reset(); form.elements.name.disabled = false; form.elements.email.disabled = false; form.elements.inboundId.disabled = false; $('#userModalTitle').textContent = '创建用户'; $('#userSubmit').textContent = '创建并启用'; populateUserInbounds(); openDialog($('#userModal')); };
$('#newTraffic').onclick = () => { $('#trafficForm').reset(); populateTrafficOptions(); openDialog($('#trafficModal')); };
$('#changePassword').onclick = () => { const modal = $('#passwordModal'); $('#passwordForm').reset(); delete modal.dataset.required; $('#passwordRequirement').hidden = true; openDialog(modal); };
$('#openSystem').onclick = () => activatePage('system');
$('#inboundProtocol').onchange = () => applyInboundTemplate(true);
$('#inboundForm').addEventListener('input', event => { if (event.target.name) event.target.dataset.auto = '0'; });
applyInboundTemplate(true);
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => { const dialog = button.closest('dialog'); if (dialog?.id === 'passwordModal') $('#passwordForm').reset(); dialog?.close(); });
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (dialog.querySelector('form[data-busy="1"]')) event.preventDefault(); }));
function setFormBusy(form, busy) {
  const submit = form.querySelector('button:not([type="button"])'); form.dataset.busy = busy ? '1' : ''; form.toggleAttribute('aria-busy', busy);
  form.querySelectorAll('[data-close]').forEach(button => { button.disabled = busy; });
  if (!submit) return;
  if (busy) { submit.dataset.idleText = submit.textContent; submit.textContent = '处理中…'; submit.disabled = true; }
  else { submit.disabled = false; if (submit.dataset.idleText) submit.textContent = submit.dataset.idleText; delete submit.dataset.idleText; }
}
async function submitOnce(event, action, onError = error => alert(error.message)) {
  event.preventDefault(); const form = event.currentTarget;
  if (form.dataset.busy === '1') return;
  setFormBusy(form, true);
  try { await action(form); } catch (error) { onError(error); } finally { setFormBusy(form, false); }
}
function confirmAgentBindingChange(select) {
  if (!select || select.dataset.initialAgentDisabled !== 'true') return true;
  const initialId = select.dataset.initialAgentId || ''; const nextId = select.value || '';
  if (nextId === initialId) return true;
  const currentName = agents.find(agent => agent.id === initialId)?.name || initialId || '未知 Agent'; const nextName = agents.find(agent => agent.id === nextId)?.name || (nextId ? nextId : '本机面板');
  return confirm(`当前资源绑定在已停用的 ${currentName}。确定将执行节点迁移到 ${nextName} 吗？`);
}
function assertEditableAgentBinding(select) {
  if (select?.dataset.initialAgentDisabled === 'true' && select.value === select.dataset.initialAgentId) throw new Error('当前执行 Agent 已停用；请先启用该 Agent，或明确选择新的执行节点后再保存。');
}
$('#form').onsubmit = event => {
  if (editingRelayId && !confirmAgentBindingChange($('#relayAgent'))) { event.preventDefault(); return; }
  return submitOnce(event, async form => { assertEditableAgentBinding($('#relayAgent')); const target = editingRelayId ? `/api/relays/${editingRelayId}` : '/api/relays'; await api(target, { method: editingRelayId ? 'PATCH' : 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); editingRelayId = null; form.reset(); $('#modal').close(); await load(); });
};
$('#agentForm').onsubmit = event => submitOnce(event, async form => { const response = await api('/api/agents', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); $('#agentModal').close(); showDeployment(response.deployment, `部署 ${response.agent.name}`); await load(); });
$('#agentEditForm').onsubmit = event => submitOnce(event, async form => {
  const data = Object.fromEntries(new FormData(form)); const agent = agents.find(item => item.id === data.id); if (!agent) throw new Error('Agent 不存在或已刷新');
  const changedController = data.controllerUrl.trim().replace(/\/$/, '') !== String(agent.controllerUrl || '').replace(/\/$/, ''); const payload = { name: data.name }; if (changedController) payload.controllerUrl = data.controllerUrl;
  const response = await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'PATCH', body: JSON.stringify(payload) }); form.reset(); $('#agentEditModal').close();
  if (response.deployment) showDeployment(response.deployment, '控制地址已更新：请重新部署'); else toast('Agent 信息已保存。', 'success'); await load();
});
$('#copyAgentCommand').onclick = async () => { try { await copyText($('#agentCommand').textContent); } catch { prompt('启动命令', $('#agentCommand').textContent); } };
$('#import3xuiForm').onsubmit = event => submitOnce(event, async form => { await api('/api/inbounds/import-3xui', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); $('#import3xuiModal').close(); await load(); });
$('#inboundForm').onsubmit = event => {
  if (editingInboundId && !confirmAgentBindingChange($('#inboundAgent'))) { event.preventDefault(); return; }
  return submitOnce(event, async form => { assertEditableAgentBinding($('#inboundAgent')); const target = editingInboundId ? '/api/inbounds/' + editingInboundId : '/api/inbounds'; await api(target, { method: editingInboundId ? 'PATCH' : 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); editingInboundId = null; form.reset(); $('#inboundProtocol').disabled = false; $('#inboundModal').close(); await load(); });
};
$('#userForm').onsubmit = event => submitOnce(event, async form => { const target = editingUserId ? `/api/users/${editingUserId}` : '/api/users'; await api(target, { method: editingUserId ? 'PATCH' : 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); editingUserId = null; form.reset(); form.elements.name.disabled = false; form.elements.email.disabled = false; form.elements.inboundId.disabled = false; $('#userModal').close(); await load(); });
$('#trafficForm').onsubmit = event => submitOnce(event, async form => { const response = await api('/api/traffic/record', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); $('#trafficModal').close(); await load(); if (response.reachedLimit) alert('该用户已达到流量配额，系统已自动暂停其访问。'); });
$('#passwordForm').onsubmit = event => submitOnce(event, async form => { const data = Object.fromEntries(new FormData(form)); if (data.newPassword !== data.confirmPassword) return toast('两次新密码不一致', 'error'); await api('/api/system/password', { method: 'POST', body: JSON.stringify(data) }); form.reset(); const modal = $('#passwordModal'); delete modal.dataset.required; modal.close(); showLogin('密码已更新，请使用新密码重新登录。'); });
$('#tlsForm').onsubmit = event => submitOnce(event, async form => { const data = Object.fromEntries(new FormData(form)); const response = await api('/api/system/tls', { method: 'POST', body: JSON.stringify(data) }); systemInfo.tls = response.tls; renderSystem(); alert('证书配置已保存。'); });
$('#requestCert').onclick = async () => { const data = Object.fromEntries(new FormData($('#tlsForm'))); try { const response = await api('/api/system/tls/request', { method: 'POST', body: JSON.stringify(data) }); systemInfo.tls = response.tls; renderSystem(); alert(response.message); } catch (error) { alert(error.message); } };
$('#applyCert').onclick = async () => { try { const response = await api('/api/system/tls/apply', { method: 'POST' }); alert(response.message); await load(); } catch (error) { alert(error.message); } };
$('#installCore').onclick = async () => { try { const version = $('#coreVersion').value.trim(); $('#installCore').disabled = true; $('#installCore').textContent = '正在下载并校验…'; const response = await api('/api/runtime/install', { method: 'POST', body: JSON.stringify({ version }) }); systemInfo.runtime = response.info; systemInfo.network = response.network || systemInfo.network; $('#coreVersion').value = ''; renderSystem(); alert(`Xray Core ${response.version || ''} 已安装，可点击“启动 Core”。`); } catch (error) { alert(error.message); await load(); } };$('#detectAddress').onclick = async () => { try { $('#detectAddress').disabled = true; $('#publicAddressDetail').textContent = '正在检测 VPS 公网地址…'; systemInfo.network = await api('/api/system/network/detect', { method: 'POST' }); renderSystem(); } catch (error) { alert(error.message); await load(); } };$('#startRuntime').onclick = async () => { try { const runtime = await api('/api/runtime/start', { method: 'POST' }); systemInfo.runtime = runtime; renderSystem(); await load(); } catch (error) { alert(error.message); } };
$('#stopRuntime').onclick = async () => { try { const runtime = await api('/api/runtime/stop', { method: 'POST' }); systemInfo.runtime = runtime; renderSystem(); } catch (error) { alert(error.message); } };
$('#downloadConfig').onclick = async () => { try { const config = await api('/api/runtime/config'); const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'xray-config.json'; link.click(); URL.revokeObjectURL(url); } catch (error) { alert(error.message); } };
$('#downloadBackup').onclick = async () => { try { const backup = await api('/api/system/backup'); const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `3xui-lite-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); toast('完整配置备份已下载，请将文件存放在安全位置。', 'success'); } catch (error) { toast(error.message, 'error'); } };
$('#refreshAudit').onclick = async () => { try { const data = await api('/api/system/audit'); auditEntries = data.entries || []; auditAvailable = true; if (systemInfo?.security) systemInfo.security.auditEntries = auditEntries.length; renderAudit(); renderSystem(); toast('审计记录已刷新。', 'success'); } catch (error) { auditAvailable = false; renderSystem(); toast(error.message, 'error'); } };
$('#passwordModal').addEventListener('cancel', event => { if ($('#passwordModal').dataset.required === 'true') event.preventDefault(); else $('#passwordForm').reset(); });
$('#passwordModal').addEventListener('close', () => $('#passwordForm').reset());
$('#modal').addEventListener('close', () => { $('#form').reset(); editingRelayId = null; });
$('#agentModal').addEventListener('close', () => $('#agentForm').reset());
$('#import3xuiModal').addEventListener('close', () => $('#import3xuiForm').reset());
$('#inboundModal').addEventListener('close', () => { resetImportedInboundEditor(); $('#inboundForm').reset(); $('#inboundProtocol').disabled = false; editingInboundId = null; });
$('#userModal').addEventListener('close', () => { const form = $('#userForm'); form.reset(); form.elements.name.disabled = false; form.elements.email.disabled = false; form.elements.inboundId.disabled = false; editingUserId = null; });
$('#trafficModal').addEventListener('close', () => $('#trafficForm').reset());
$('#qrModal').addEventListener('close', () => { $('#qrImage').removeAttribute('src'); $('#qrTitle').textContent = '节点二维码'; });
$('#agentBootstrapModal').addEventListener('close', () => { $('#agentCommand').textContent = ''; $('#agentBootstrapTitle').textContent = '部署 Agent'; });
$('#agentDetailsModal').addEventListener('close', () => { $('#agentDetailsBody').replaceChildren(); $('#agentDetailsTitle').textContent = 'Agent 详情'; });
$('#agentEditModal').addEventListener('close', () => { $('#agentEditForm').reset(); $('#agentEditTitle').textContent = '编辑 Agent'; });
$('#diagnosticsModal').addEventListener('close', () => { $('#diagnosticsBody').replaceChildren(); $('#diagnosticsTitle').textContent = '线路诊断报告'; diagnosticsText = ''; });
$('#loginForm').onsubmit = event => submitOnce(event, async form => { const data = Object.fromEntries(new FormData(form)); const response = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) }); if (response.transportWarning) toast(response.transportWarning, 'error'); hideLogin(); form.reset(); if (response.mustChangePassword) return forcePasswordChange(); await load(); focusActivePage(); }, error => { $('#loginNote').textContent = error.message; });
$('#logout').onclick = async () => { const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000); try { await api('/api/auth/logout', { method: 'POST', signal: controller.signal }); clearAuthenticatedState(); showLogin('已安全退出。'); } catch (error) { if (error.status !== 401) toast(`退出失败：${error.name === 'AbortError' ? '请求超时' : error.message}。当前会话未确认失效。`, 'error'); } finally { clearTimeout(timeout); } };
function setTheme(dark) {
  document.body.classList.toggle('dark', dark); const label = dark ? '切换到浅色主题' : '切换到深色主题'; $('#theme').setAttribute('aria-pressed', String(dark)); $('#theme').setAttribute('aria-label', label); $('#theme').title = label; $('#theme').textContent = dark ? '☾' : '☼';
  try { localStorage.setItem('3xui-theme', dark ? 'dark' : 'light'); } catch {}
}
let initialDark = false; try { const saved = localStorage.getItem('3xui-theme'); initialDark = saved ? saved === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches; } catch {}
setTheme(initialDark);
$('#theme').onclick = () => setTheme(!document.body.classList.contains('dark'));
$('#menu').onclick = () => { const open = !$('.sidebar').classList.contains('open'); $('.sidebar').classList.toggle('open', open); document.body.classList.toggle('nav-open', open); $('#menu').setAttribute('aria-expanded', String(open)); $('#menu').setAttribute('aria-label', open ? '关闭菜单' : '打开菜单'); syncApplicationAccess(); };
$('#sidebarScrim').onclick = closeSidebar; mobileNavigation.addEventListener?.('change', closeSidebar);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('.sidebar').classList.contains('open')) { closeSidebar(); $('#menu').focus(); } });
function operationsPageVisible() { return ['overview', 'relays', 'agents'].includes($('.page.active')?.id); }
function canAutoRefreshOperations() { return !document.hidden && !applicationLocked && operationsPageVisible() && !document.querySelector('dialog[open]') && !autoOperationsRefreshBlocked(); }
setInterval(() => {
  if (canAutoRefreshOperations()) refreshOperations();
}, 15000);
document.addEventListener('visibilitychange', () => { if (canAutoRefreshOperations()) refreshOperations(); });
const initialPage = location.hash.slice(1); if (pageNames[initialPage]) activatePage(initialPage, false);
(async () => { try { const session = await api('/api/auth/me'); if (session.authenticated) { hideLogin(); if (session.mustChangePassword) forcePasswordChange(); else { await load(); focusActivePage(); } } else showLogin(); } catch { showLogin('无法连接面板服务，请确认已运行 node server.js。'); } })();
