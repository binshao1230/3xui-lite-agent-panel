# 3xUI Lite Agent Panel

A deployable Xray control panel with protocol templates, traffic records, Agent management, remote TCP/UDP relay, remote Xray inbound distribution, Agent self-update, and remote Xray Core installation.

## One-command Linux deployment

Run as root or through sudo on a systemd Linux VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo bash
```

The installer installs Node.js 20 LTS when necessary, installs dependencies, and starts the `3xui-lite-agent-panel` systemd service on port `3000`.

```bash
sudo systemctl status 3xui-lite-agent-panel
sudo journalctl -u 3xui-lite-agent-panel -f
```

Use another panel port:

```bash
curl -fsSL https://raw.githubusercontent.com/binshao1230/3xui-lite-agent-panel/main/install.sh | sudo PORT=8443 bash
```

Initial credentials are `admin / admin`. Change the password immediately after the first login.

## Release archive

The `release/3xui-lite-linux.tar.gz` archive contains the same deployable source. Extract it and run:

```bash
sudo bash ./deploy-linux.sh
```

## Agent requirements

Agents are deployed as systemd services. The Agent can receive Xray installation, node configuration, and relay rules from the panel. Agent-side Xray installation currently supports Linux x64, arm64, and arm.