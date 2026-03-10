# Tailscale Preview Setup Guide

When Tailscale is installed and connected, GeminiClaw's preview server automatically provides an access URL via your tailnet.

## Prerequisites

- [Tailscale](https://tailscale.com/download) installed and connected to your tailnet

## Enabling HTTPS (via tailscale serve)

HTTPS access via `tailscale serve` requires HTTPS certificates to be enabled on your tailnet.

1. Open the [Tailscale Admin Console](https://login.tailscale.com/admin/dns)
2. Go to the **DNS** tab → **HTTPS Certificates** section
3. Turn on **Enable HTTPS**

This automatically issues TLS certificates for your MagicDNS name (e.g. `machine-name.tail12345.ts.net`).

## Behavior

During GeminiClaw startup, the preview URL is determined by Tailscale's state:

| Tailscale State | Preview URL |
|---|---|
| Connected + HTTPS enabled | `https://<hostname>/preview` (via tailscale serve) |
| Connected + HTTPS not enabled | `http://<tailscale-ip>:<port>/preview` (direct IP access) |
| Not installed / disconnected | `http://localhost:<port>/preview` (local only) |

## Verification

```bash
# Check Tailscale connection status
tailscale status

# Check Tailscale IP
tailscale ip -4

# Check tailscale serve status
tailscale serve status
```

## macOS Notes

On macOS with Tailscale.app installed, the CLI is located at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. GeminiClaw auto-detects this path, so there is no need to add it to your PATH.
