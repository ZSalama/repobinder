# Contributing

RepoBinder is a desktop-first Git worktree manager. Keep changes aligned with the vocabulary in [CONTEXT.md](./CONTEXT.md), especially Repository, Primary Worktree, Linked Worktree, Worktree Setup Script, and Dev Server.

## Development Setup

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run desktop
```

Use Node.js 22 or newer and pnpm 11 or newer.

## Pull Requests

- Keep changes focused on one behavior or documentation area.
- Include the validation you ran, such as `pnpm run typecheck` or `pnpm run build`.
- Update README, SCRIPT_REQUIREMENTS, CONTEXT, or ADRs when behavior changes their documented contract.
- Treat remote mode, command execution, filesystem deletion, branch deletion, and setup scripts as security-sensitive areas.
- Do not commit local stores, logs, `.env` files, generated build output, or machine-specific settings.

## Issues

Bug reports should include the operating system, Node.js version, pnpm version, Git version, the command or UI flow used, and the expected versus actual result.

Feature requests should describe the worktree workflow they support and whether they affect desktop mode, browser mode, Worktree Setup Scripts, or remote access.
