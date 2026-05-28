# RepoBinder

RepoBinder is a desktop-first tool for creating and deleting Git worktrees.

## Architecture

- Electron starts the backend as a child process.
- The backend binds to `127.0.0.1` by default and serves the React build.
- The Electron window loads `http://127.0.0.1:<port>`.
- The same backend can bind to `0.0.0.0` for LAN or Tailscale access.
- The backend exposes HTTP APIs and a WebSocket channel for worktree updates.

Remote mode is intentionally opt-in. Add authentication before using it on an untrusted network.

## Development

```sh
pnpm install
pnpm run build
pnpm run desktop
```

To bind the backend to all interfaces:

```sh
pnpm run dev:remote
```

The backend defaults to port `3773`. Electron will scan upward if that port is unavailable.

## Server Only

```sh
pnpm run build
HOST=127.0.0.1 PORT=3773 pnpm run start
```

Open `http://127.0.0.1:3773` in a browser.
