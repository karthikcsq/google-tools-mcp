# Remote OAuth with a persistent SSH tunnel

`google-tools-mcp` normally creates a temporary OAuth callback listener on a random loopback port. That works when the browser and MCP server run on the same computer.

If the MCP runs on a remote host but you approve Google OAuth in a browser on your laptop, use a fixed callback port plus a persistent SSH **local** forward. The callback stays loopback-only on both machines; no Google credential or MCP endpoint is publicly exposed.

## 1. Choose a fixed callback port

This guide uses `37547`. Run the auth flow on the remote MCP host with:

```bash
GOOGLE_MCP_OAUTH_PORT=37547 google-tools-mcp auth
```

`GOOGLE_MCP_OAUTH_PORT` must be an integer from `1` through `65535`. If omitted, the existing random-port behavior is unchanged.

## 2. Create the local forward on the laptop

Create `~/.config/systemd/user/google-tools-mcp-oauth-tunnel.service` with the following content. Replace `YOUR_REMOTE_SSH_HOST` with the SSH host alias or hostname for the computer that runs the MCP.

```ini
[Unit]
Description=Forward Google MCP OAuth callback to the remote Hermes host
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:37547:127.0.0.1:37547 YOUR_REMOTE_SSH_HOST
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now google-tools-mcp-oauth-tunnel.service
systemctl --user status google-tools-mcp-oauth-tunnel.service
```

For a laptop that should keep the tunnel alive after logout, also enable user lingering once:

```bash
loginctl enable-linger "$USER"
```

## 3. Authenticate from the laptop browser

Start the remote `google-tools-mcp auth` command from step 1. Open the printed Google authorization URL on the laptop. Google redirects to `http://localhost:37547`; the local SSH tunnel forwards that request to the remote MCP callback listener, where the token is stored.

## Troubleshooting

- **`Address already in use`**: Pick another unused fixed port and update both `GOOGLE_MCP_OAUTH_PORT` and the systemd unit's `-L` option.
- **Callback hangs in the browser**: Confirm the tunnel is active with `systemctl --user status google-tools-mcp-oauth-tunnel.service`, and keep the remote `google-tools-mcp auth` process running while approving.
- **SSH hostname is unknown**: Test it first with `ssh YOUR_REMOTE_SSH_HOST true`; use the same host alias in the unit.
- **Do not use `0.0.0.0`**: The tunnel and callback should stay bound to `127.0.0.1` / `localhost` only.
