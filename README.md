# 3xUI Lite Agent Panel v0.7.2

面向 Linux VPS 的 Xray 管理与中转面板，提供协议配置模板、流量统计、Agent 管理、远程 TCP/UDP 中转、远程入站下发、Agent 自更新，以及远程安装 Xray Core 等能力。

## Linux 一键部署

请在使用 systemd 的 Linux VPS 中，以 root 身份执行，或通过 sudo 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo bash
```

安装程序仅支持仍在维护的 Node.js 22 LTS 或 24 LTS，并会在必要时安装 Node.js 24 LTS，然后启动监听 `3000` 端口的 `3xui-lite-agent-panel` systemd 服务。

该默认命令适合已限制来源地址的管理网络。不要将 HTTP 管理端口向 `0.0.0.0/0` 开放；生产环境应优先使用 HTTPS 反向代理，并把面板仅绑定到回环地址：

```bash
curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo PANEL_HOST=127.0.0.1 SECURE_COOKIE=true TRUST_PROXY=true bash
```

安装后检查服务：

```bash
sudo systemctl status 3xui-lite-agent-panel
sudo journalctl -u 3xui-lite-agent-panel -f
```

标准安装器会在当前终端直接显示一次性随机密码，不把它写入 systemd 环境。仅在绕过安装器、由服务自身完成兜底初始化时，才需使用 `sudo journalctl -u 3xui-lite-agent-panel -n 50 --no-pager` 查看首次启动输出。

指定其他面板端口：

```bash
curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo PORT=8443 bash
```

新安装会在安装终端中一次性显示管理员账号 `admin` 和随机初始密码；请立即保存并在首次登录后修改。升级不会重新生成或覆盖现有管理员凭据，完成密码修改前其他管理 API 保持锁定。

再次执行安装命令升级时，脚本会先在临时目录按锁文件安装依赖、禁用依赖安装脚本并完成语法检查；已有的端口、监听地址以及 Cookie/代理安全设置会继续沿用，除非在升级命令中显式覆盖。

自定义 `APP_DIR` 必须使用独立的非符号链接应用目录，例如 `/opt/3xui-lite-agent-panel`；从根目录到目标目录的每一级现有目录都必须由 `root:root` 所有且不可由组/其他用户写入，安装器也会拒绝根目录、关键系统目录及可造成 systemd 单元转义或路径绕过的值。

部署完成后，本轮发布的应用源码和依赖归 `root:root` 所有，组及其他用户写权限会被移除；已知敏感数据文件固定为 `0600`。升级失败时会恢复这些文件原有的所有权和权限。

默认一键安装脚本固定下载 `v0.7.2` 标签。受控生产发布可将 `install.sh` 原始地址中的 `main` 固定为经过审核的完整 Git commit SHA，并通过 `REF` 指定同一标签或提交；如需跟随分支可显式传入 `BRANCH`。还可传入 `SOURCE_SHA256` 对下载的源码包进行 SHA-256 校验。

## v0.7.2 商用可靠性与安全加固

- 新安装改用一次性随机管理员密码；部署器不再把凭据写入 systemd 环境，面板兜底初始化也只在首次启动日志中显示一次。
- Agent 控制通道默认强制 HTTPS，仅允许回环地址使用 HTTP；授权撤销或不安全通道会立即停止远程入站和中转。
- Agent 更新及 Xray 安装任务采用持久化的一次性结果，失败或中断后不会在每次心跳中重复下载；任务错误会回传面板。
- 用户配额降低或耗尽时立即停用账号并移除节点访问；修复小数配额、当地日期统计和当日流量展示精度。
- TLS 证书保存前验证 PEM 与密钥配对；损坏的持久化证书不再阻止面板以 HTTP 安全启动，运行时文件采用校验后原子发布。
- 部署升级改为源码、依赖与 systemd 单元的事务式发布；启动失败自动恢复上一版本，并保留现有网络和 Cookie/代理安全设置。
- 完善键盘焦点、弹窗清理、移动端侧栏隔离、操作状态及安全检查展示，减少误操作和敏感信息残留。
- 面板升级为 v0.7.2，Agent 升级为 v0.5.5；运行环境限定为仍受维护的 Node.js 22 LTS 或 24 LTS。

## v0.7.1 可靠性修复

- 数据文件损坏时停止写入并返回错误，不再退回默认管理员或用空数组覆盖原数据。
- 修复并发登录限流、小数流量配额、入站与中转端口冲突，以及入站编辑字段和用户链接不同步。
- 3x-ui 导入节点编辑时保留原始协议、自定义传输字段与客户端凭据，避免被内置模板覆盖。
- 修复离线 Agent 入站无法暂停、退出后敏感界面残留、密码弹窗字段残留和可选接口拖垮主界面。
- HTTPS 请求自动使用 Secure Cookie；备份与 Agent 凭据读取进入审计记录。
- Agent 长期令牌移出进程参数，改由权限为 `0600` 的 systemd 环境文件加载。

## v0.7 商用运维基线

- **一次性初始凭据**：新安装生成高强度随机初始密码并强制首次修改；历史默认凭据仍会被识别并在修改前锁定其他管理接口。
- **管理员操作审计**：记录登录成功/失败、配置写操作、响应状态、来源 IP 和客户端信息，私有保存最近 1,000 条。
- **完整配置备份**：系统页可导出账号哈希、Agent 令牌、节点、用户、流量和审计记录，并附带 SHA-256 完整性校验。备份含敏感凭据，应仅通过 HTTPS 下载并离线加密保存。
- **跨站写入保护**：浏览器写操作校验 Origin/Host，配合 `SameSite=Strict` Cookie 降低跨站请求风险。
- **安全状态总览**：系统页集中显示首次凭据、HTTPS、Secure Cookie、审计和 Agent 控制链路状态。
- **数据引用保护**：仍承载资源的 Agent、仍分配给用户的入站不能直接删除，避免产生悬空配置。
- **部署加固**：systemd 服务增加内核、SUID、地址族、资源上限和停止超时限制。
## 管理入口与防火墙

面板默认显式监听 `0.0.0.0:3000`，仅应在云安全组和系统防火墙已限制管理来源时使用。如果本机服务正常但浏览器访问超时，请先确认监听状态：

```bash
sudo ss -lntp | grep :3000
curl http://127.0.0.1:3000/api/health
```

在腾讯云、阿里云、AWS 等云平台的安全组/防火墙中，添加一条入站规则：`TCP`、端口 `3000`、来源为实际管理 IP 或管理网段，禁止使用 `0.0.0.0/0`。若系统使用 UFW，请将示例地址替换为管理员出口公网 IP：

```bash
sudo ufw allow from 203.0.113.10/32 to any port 3000 proto tcp
sudo ufw status
```

## Linux 发布包

`release/3xui-lite-linux.tar.gz` 包含同一份可部署源码，但不内置 `node_modules`，安装时仍需访问 npm。解压后运行：

```bash
tar -xzf 3xui-lite-linux.tar.gz
cd 3xui-lite-linux
sudo bash ./deploy-linux.sh
```

## Agent 运行要求

Agent 通过 systemd 服务部署。它可以接收面板下发的 Xray 安装、节点配置及中转规则。部署引导会自动检查 Node.js 版本，并在必要时安装 Node.js 24 LTS，因此纯净的常见 Linux VPS 也可直接执行部署命令。Agent 端自动安装 Xray 当前支持 Linux x64、arm64 和 arm 架构。面板本机也支持从系统页面安装官方 Xray Core；版本可填写 `v26.3.27`、`26.3.27`，或留空安装最新版。

## 安全建议

- 首次登录后立刻修改安装终端显示的一次性随机密码。
- 对外暴露前请通过反向代理或证书配置 HTTPS。
- 防火墙仅放行面板端口，以及实际启用的节点或中转端口。
- 运行时数据、节点配置、审计记录和 Agent 令牌均不会被提交到仓库或包含在发布源码中。
## 3x-ui 入站配置兼容

入站页面提供“导入 3x-ui 配置”入口，可粘贴 3x-ui 导出的单个入站 JSON。支持 VLESS（含 Reality、TCP、TLS、WebSocket、gRPC）、Trojan 与 Shadowsocks；导入时会保留原始 UUID、用户密码、Reality 私钥、shortId、传输层和 TLS 参数。

面板启动时还会对已有入站进行非破坏性兼容迁移，补齐 Xray/3x-ui 使用的 `fallbacks`、`tcpSettings`、Reality 版本字段和 sniffing 字段，不会改写端口、UUID、密钥或用户数据。每次本机 Core 启动/重载前，都会先执行 Xray 配置校验；不通过时在系统页显示具体错误，避免写入无效配置。
## 节点自检与修复

每个本机入站卡片均提供“修复并诊断”。它会校验完整 Xray 配置、启动或重载本机 Core、确认本机监听端口，并检查 Reality 伪装站点可达性和密钥字段。TLS 入站还会确认实际证书与私钥文件是否存在。

若本机端口已监听而客户端仍不可用，诊断结果会明确提示检查云安全组与系统防火墙；请放行对应的 TCP 节点端口。系统设置中的“应用至 TLS 入站”会同步证书到 VLESS TLS、WebSocket TLS、gRPC TLS 和 Trojan TLS（仅本机面板节点）。远程 Agent 请填写该机器上的证书路径。

## 运行时稳定性修复

Agent 下发多个入站时会逐一确认所有监听端口，不再只检查第一个端口；重载 Xray 时会等待旧进程退出，并隔离旧进程回调，避免状态被覆盖。禁用或撤销 Agent 授权时，Agent 会同时停止中转与 Xray 入站。

本机 TCP 中转已修复连接计数不回收的问题。应用 TLS 证书后，如果存在已启用的本机入站，面板会自动启动或重载 Xray Core。
## 用户有效期与配额

用户到期后，面板会在启动时、每分钟及 API 操作时自动停用该用户，并从已分配的 Xray 入站移除访问凭据。用户卡片会显示“已到期”，点击“编辑”可调整到期日或流量配额；设置为未来日期后即可重新启用。无效日期（例如 `2026-02-30`）会被拒绝，不会被自动转换为其他日期。

Agent 如在 Xray 安装或自身更新过程中异常中断，重启后会将该任务标记为失败并回传面板，等待管理员明确重新下发，避免反复下载或更新循环。

## Let's Encrypt 证书申请

面板内置申请使用 certbot 的 standalone HTTP-01 验证，会在申请期间临时监听 TCP `80`。证书域名必须有 A/AAAA 记录解析到这台 VPS，并在云安全组、系统防火墙中放行 TCP `80`；同时 Nginx、Apache 等服务不能占用该端口。Let’s Encrypt 不支持为纯 IP 地址签发证书。若不能暂时释放 80 端口，请使用反向代理自行完成验证，或在面板中填写已有证书与私钥路径。
## TLS 节点保护

TLS、WebSocket、gRPC 和 Trojan 模板不会再在缺少证书时写入会使 Xray 失败的配置。本机节点使用系统设置中已保存的证书；远程 Agent 节点必须填写该 Agent 机器上的证书和私钥路径。已有的无证书 TLS 节点会在面板中明确标为异常，并自动排除在本机 Core 配置之外，不会再拖垮其他可用节点；同样的无效节点不会下发到远程 Agent。
## 商用部署基线

- 不要直接把 HTTP 面板暴露到公网；使用 Nginx、Caddy 或负载均衡器提供 HTTPS，并将面板端口限制为反向代理或管理网段可访问。
- HTTPS 反向代理场景可用 `SECURE_COOKIE=true TRUST_PROXY=true` 部署，使管理员会话 Cookie 仅通过 HTTPS 发送，并信任反向代理的 HTTPS 标记：`curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo PANEL_HOST=127.0.0.1 SECURE_COOKIE=true TRUST_PROXY=true bash`。面板端口必须同时限制为仅反向代理可访问。
- 首次登录后必须修改安装终端显示的一次性初始密码；完成前面板会拦截其他管理操作。
- 面板数据采用私有文件权限和原子写入；仍应对 `/opt/3xui-lite-agent-panel` 中的运行数据定期离机备份，并在升级前创建快照。
- 建议仅放行面板 HTTPS、已启用节点端口和必要的 Agent 回连路径；Agent 令牌、管理员 Cookie 与节点 JSON 都应视为敏感凭据。
