# 3xUI Lite Agent Panel v0.7.0

面向 Linux VPS 的 Xray 管理与中转面板，提供协议配置模板、流量统计、Agent 管理、远程 TCP/UDP 中转、远程入站下发、Agent 自更新，以及远程安装 Xray Core 等能力。

## Linux 一键部署

请在使用 systemd 的 Linux VPS 中，以 root 身份执行，或通过 sudo 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo bash
```

安装程序会在必要时安装 Node.js 20 LTS、安装项目依赖，并启动监听 `3000` 端口的 `3xui-lite-agent-panel` systemd 服务。

```bash
sudo systemctl status 3xui-lite-agent-panel
sudo journalctl -u 3xui-lite-agent-panel -f
```

指定其他面板端口：

```bash
curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo PORT=8443 bash
```

初始账号密码为 `admin / admin`。首次登录后，面板会强制修改默认密码；完成前其他管理 API 保持锁定。


## v0.7 商用运维基线

- **强制默认密码迁移**：自动识别仍在使用 `admin / admin` 的历史安装；修改密码前锁定其他管理接口。
- **管理员操作审计**：记录登录成功/失败、配置写操作、响应状态、来源 IP 和客户端信息，私有保存最近 1,000 条。
- **完整配置备份**：系统页可导出账号哈希、Agent 令牌、节点、用户、流量和审计记录，并附带 SHA-256 完整性校验。备份含敏感凭据，应仅通过 HTTPS 下载并离线加密保存。
- **跨站写入保护**：浏览器写操作校验 Origin/Host，配合 `SameSite=Strict` Cookie 降低跨站请求风险。
- **安全状态总览**：系统页集中显示默认密码、HTTPS、Secure Cookie 和审计状态。
- **数据引用保护**：仍承载资源的 Agent、仍分配给用户的入站不能直接删除，避免产生悬空配置。
- **部署加固**：systemd 服务增加内核、SUID、地址族、资源上限和停止超时限制。
## 无法从外网访问时

面板默认显式监听 `0.0.0.0:3000`。如果本机服务正常但浏览器访问超时，请检查云平台安全组和系统防火墙：

```bash
sudo ss -lntp | grep :3000
curl http://127.0.0.1:3000/api/health
```

在腾讯云、阿里云、AWS 等云平台的安全组/防火墙中，添加一条入站规则：`TCP`、端口 `3000`、来源按实际管理 IP 限制（测试时可临时使用 `0.0.0.0/0`）。若系统使用 UFW：

```bash
sudo ufw allow 3000/tcp
sudo ufw status
```

## 离线部署包

`release/3xui-lite-linux.tar.gz` 包含同一份可部署源码。解压后运行：

```bash
sudo bash ./deploy-linux.sh
```

## Agent 运行要求

Agent 通过 systemd 服务部署。它可以接收面板下发的 Xray 安装、节点配置及中转规则。部署引导会自动检查并安装 Node.js 20 LTS，因此纯净的常见 Linux VPS 也可直接执行部署命令。Agent 端自动安装 Xray 当前支持 Linux x64、arm64 和 arm 架构。面板本机也支持从系统页面安装官方 Xray Core；版本可填写 `v26.3.27`、`26.3.27`，或留空安装最新版。

## 安全建议

- 首次登录后立刻修改默认 `admin / admin` 密码。
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

Agent 如在 Xray 安装过程中异常中断，重启后会自动解除残留的“安装中”状态，允许面板重新下发安装任务。

## Let's Encrypt 证书申请

面板内置申请使用 certbot 的 standalone HTTP-01 验证，会在申请期间临时监听 TCP `80`。证书域名必须有 A/AAAA 记录解析到这台 VPS，并在云安全组、系统防火墙中放行 TCP `80`；同时 Nginx、Apache 等服务不能占用该端口。Let’s Encrypt 不支持为纯 IP 地址签发证书。若不能暂时释放 80 端口，请使用反向代理自行完成验证，或在面板中填写已有证书与私钥路径。
## TLS 节点保护

TLS、WebSocket、gRPC 和 Trojan 模板不会再在缺少证书时写入会使 Xray 失败的配置。本机节点使用系统设置中已保存的证书；远程 Agent 节点必须填写该 Agent 机器上的证书和私钥路径。已有的无证书 TLS 节点会在面板中明确标为异常，并自动排除在本机 Core 配置之外，不会再拖垮其他可用节点；同样的无效节点不会下发到远程 Agent。
## 商用部署基线

- 不要直接把 HTTP 面板暴露到公网；使用 Nginx、Caddy 或负载均衡器提供 HTTPS，并将面板端口限制为反向代理或管理网段可访问。
- HTTPS 反向代理场景可用 `SECURE_COOKIE=true TRUST_PROXY=true` 部署，使管理员会话 Cookie 仅通过 HTTPS 发送，并信任反向代理的 HTTPS 标记：`curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo SECURE_COOKIE=true TRUST_PROXY=true bash`。面板端口必须同时限制为仅反向代理可访问。
- 首次登录后请尽快修改默认管理员密码；面板不会强制拦截管理操作。
- 面板数据采用私有文件权限和原子写入；仍应对 `/opt/3xui-lite-agent-panel` 中的运行数据定期离机备份，并在升级前创建快照。
- 建议仅放行面板 HTTPS、已启用节点端口和必要的 Agent 回连路径；Agent 令牌、管理员 Cookie 与节点 JSON 都应视为敏感凭据。
