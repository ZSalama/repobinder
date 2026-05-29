# Security Policy

RepoBinder is pre-1.0. The `main` branch is the only supported line for security fixes.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting for this repository when it is available. If private reporting is not available, open a minimal GitHub issue asking for a private contact path and do not include exploit details, tokens, local paths, or sensitive repository information in the public issue.

## Current Security Notes

- RepoBinder binds to `127.0.0.1` by default.
- Remote mode binds to `0.0.0.0` and is currently unauthenticated for browser clients. Use it only on trusted networks.
- Worktree Setup Scripts run local commands in worktrees. Review scripts before enabling setup automation.
- The local store records filesystem paths, worktree metadata, process metadata, and operation history. It is not a secret store.
- Never include credentials, API keys, tokens, or private file contents in setup metadata, warnings, logs, or bug reports.
