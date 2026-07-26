# 3xUI Lite · Linux deployment

This bundle runs the panel and its Agent management service on Linux with systemd.

## Requirements

- Debian/Ubuntu, Rocky/Alma, CentOS, or another systemd-based Linux distribution
- root or sudo access
- Node.js 18 or later
- Internet access for `npm ci`

## Install

```bash
tar -xzf 3xui-lite-linux.tar.gz
cd 3xui-lite-linux
sudo bash ./deploy-linux.sh
```

The service is named `3xui-lite` and listens on port `3000` by default.

```bash
sudo systemctl status 3xui-lite
sudo journalctl -u 3xui-lite -f
```

Set another port when installing:

```bash
sudo PORT=8443 bash ./deploy-linux.sh
```

## Xray Core

The panel can install its local Xray Core from the System page. Agent machines can receive an Xray installation task from the **Install Xray** action; that workflow requires a Linux systemd Agent with root privileges and supports x64, arm64, and arm.

## Security

- Change the initial `admin / admin` credentials immediately.
- Put the panel behind HTTPS before exposing it publicly.
- Open only the panel and explicitly configured node/relay ports in the firewall.
- Runtime data (`settings.json`, node and user data, Agent tokens) is intentionally excluded from the source package and repository.