# 3xUI Lite Agent Panel

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

初始账号密码为 `admin / admin`。首次登录后请立即修改密码。

## 离线部署包

`release/3xui-lite-linux.tar.gz` 包含同一份可部署源码。解压后运行：

```bash
sudo bash ./deploy-linux.sh
```

## Agent 运行要求

Agent 通过 systemd 服务部署。它可以接收面板下发的 Xray 安装、节点配置及中转规则。Agent 端自动安装 Xray 当前支持 Linux x64、arm64 和 arm 架构。

## 安全建议

- 首次登录后立刻修改默认 `admin / admin` 密码。
- 对外暴露前请通过反向代理或证书配置 HTTPS。
- 防火墙仅放行面板端口，以及实际启用的节点或中转端口。
- 运行时数据、节点配置和 Agent 令牌均不会被提交到仓库或包含在发布源码中。
