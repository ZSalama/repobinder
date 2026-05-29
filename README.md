# RepoBinder

RepoBinder is a local desktop app for keeping a Git repository's worktrees visible, organized, and disposable. It wraps `git worktree` with an Electron shell, a local HTTP backend, and a React dashboard.

RepoBinder is early software. It is built for local development workflows today; packaged installers and hardened remote access are not in place yet.

## Features

- Add a local Repository by selecting its Primary Worktree.
- View the Primary Worktree and Linked Worktrees attached to the Repository.
- Create one or more Linked Worktrees from a Base Branch.
- Optionally run a repository-owned Worktree Setup Script after creation.
- Track setup activity, process metadata, Dev Server URLs, and recent operations.
- Remove Linked Worktrees and optionally delete their branches.
- Run as an Electron desktop app or as a local browser-accessible backend.

## Security Model

RepoBinder is designed to run on a developer machine and binds to `127.0.0.1` by default.

Remote or LAN access is opt-in through `REPOBINDER_REMOTE=1` for the desktop app, or `HOST=0.0.0.0` for the standalone backend. Browser clients in remote mode are not authenticated yet, so use remote mode only on trusted networks. Add authentication before exposing RepoBinder to an untrusted network.

Worktree Setup Scripts run local commands inside your worktrees. Review scripts before enabling setup automation for a Repository.

## Requirements

- Node.js 22 or newer
- pnpm 11 or newer
- Git

## Quick Start

```sh
pnpm install
pnpm run build
pnpm run desktop
```

The desktop app starts the backend as a child process, waits for `/health`, and loads the React app from `http://127.0.0.1:<port>`. The default port is `3774`; Electron scans upward if that port is unavailable.

## Browser Mode

```sh
pnpm run build
HOST=127.0.0.1 PORT=3774 pnpm run start
```

Open `http://127.0.0.1:3774` in a browser.

To bind the backend to all interfaces:

```sh
HOST=0.0.0.0 PORT=3774 pnpm run start
```

For desktop remote mode:

```sh
pnpm run dev:remote
```

## Development

```sh
pnpm run typecheck
pnpm run build
pnpm run clean
```

Useful scripts:

- `pnpm run build` builds the web app, backend, and Electron entrypoints.
- `pnpm run desktop` starts the built desktop app.
- `pnpm run dev` builds and starts the desktop app in one command.
- `pnpm run start` starts only the backend.
- `pnpm run typecheck` runs TypeScript checks for the web, server, and desktop apps.

## Worktree Setup Scripts

RepoBinder can run a repository-owned setup command after it creates a Linked Worktree. The setup contract, environment variables, Dev Server metadata format, and examples are documented in [SCRIPT_REQUIREMENTS.md](./SCRIPT_REQUIREMENTS.md).

## Local Data

RepoBinder stores local state in `repobinder-store.json`.

- Desktop mode stores data under Electron's per-user app data directory.
- Server mode stores data in `$REPOBINDER_DATA_DIR` when set.
- Without `$REPOBINDER_DATA_DIR`, Linux uses `$XDG_DATA_HOME/repobinder` or `~/.local/share/repobinder`, macOS uses `~/Library/Application Support/RepoBinder`, and Windows uses `%APPDATA%/RepoBinder`.

The store contains local filesystem paths, worktree records, tracked process metadata, and recent operations. It is not intended to store secrets.

## Project Docs

- [CONTEXT.md](./CONTEXT.md) defines the project vocabulary.
- [SCRIPT_REQUIREMENTS.md](./SCRIPT_REQUIREMENTS.md) defines the Worktree Setup Script contract.
- [docs/adr](./docs/adr) records architectural decisions.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and pull request guidance. Security reporting guidance is in [SECURITY.md](./SECURITY.md).

## License

RepoBinder is released under the [MIT License](./LICENSE).
