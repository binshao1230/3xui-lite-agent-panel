# 3xUI Lite · Linux 部署说明

本部署包会在 Linux 上通过 systemd 运行面板及其 Agent 管理服务。

## 环境要求

- Debian/Ubuntu、Rocky/Alma、CentOS，或其他支持 systemd 的 Linux 发行版
- root 权限或 sudo 权限
- Node.js 18 或更高版本（部署脚本可自动安装）
- 可访问 npm 的网络环境

## 安装方式

```bash
tar -xzf 3xui-lite-linux.tar.gz
cd 3xui-lite-linux
sudo bash ./deploy-linux.sh
```

服务名称为 `3xui-lite-agent-panel`，默认监听 `3000` 端口。

```bash
sudo systemctl status 3xui-lite-agent-panel
sudo journalctl -u 3xui-lite-agent-panel -f
```

## 外网访问检查

面板默认监听 `0.0.0.0:3000`。若服务器本机访问正常而浏览器超时，请在云平台安全组中放行 TCP `3000` 端口，并检查系统防火墙。可执行：

```bash
sudo ss -lntp | grep :3000
curl http://127.0.0.1:3000/api/health
sudo ufw allow 3000/tcp  # 使用 UFW 时
```

安装时设置其他端口：

```bash
sudo PORT=8443 bash ./deploy-linux.sh
```

## Xray Core

可在面板的系统页面安装本机 Xray Core。Agent 机器可通过“安装 Xray”操作接收安装任务；该功能要求 Agent 运行在具有 root 权限的 systemd Linux 服务中，支持 x64、arm64 和 arm 架构。

## 安全建议

- 立即修改初始 `admin / admin` 账号密码。
- 面板公开访问前请配置 HTTPS。
- 防火墙只开放面板端口，以及明确启用的节点和中转端口。
- 运行时数据（`settings.json`、节点和用户数据、Agent 令牌）会被刻意排除在源码包和仓库之外。
