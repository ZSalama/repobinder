# RepoBinder Worktree Setup Script Requirements

This document describes the contract for a repository-owned Worktree Setup Script used by RepoBinder.

Use this document to guide an LLM or a developer when creating a setup script for a project that will be managed by RepoBinder.

## Core Boundary

RepoBinder owns Git worktree management. The Worktree Setup Script owns only project-specific setup after RepoBinder has already created a Linked Worktree.

RepoBinder is responsible for:

- Adding a Repository from a Primary Worktree.
- Choosing the Base Branch from the Primary Worktree.
- Validating Branch names before mutation.
- Generating Linked Worktree paths next to the Primary Worktree.
- Running `git worktree add -b <branch> <worktree-path> <base-branch>`.
- Registering Worktree Records, Dev Server metadata, Tracked Processes, and Operation Records.
- Deleting Linked Worktrees with `git worktree remove`.
- Optionally deleting Branches during Linked Worktree deletion.
- Stopping Tracked Processes during Linked Worktree deletion.

The Worktree Setup Script is responsible for:

- Running inside the newly created Linked Worktree.
- Installing project dependencies.
- Copying or creating local runtime configuration files required by that project.
- Running project bootstrap steps.
- Optionally starting a Dev Server when RepoBinder passes `--port <number>`.
- Optionally reporting setup status, warnings, Dev Server metadata, and process metadata as JSON.

The Worktree Setup Script must not be the source of truth for Branch, Worktree Path, Repository, or Worktree Record state.

## Repository Settings

Each Repository can enable or disable a Worktree Setup Script in Repository Settings.

Setup is optional. RepoBinder can create Linked Worktrees with setup disabled.

Repository Settings store setup configuration as structured argv:

- `enabled`: whether setup runs for newly created Linked Worktrees.
- `command`: executable name or script path.
- `defaultArgs`: default argv entries for every setup run in that Repository.
- `autoStartDevServer`: whether RepoBinder reserves a port and appends `--port <number>`.

Recommended command shape:

```text
scripts/repobinder-setup
```

Command requirements:

- If setup is enabled, `command` is required.
- RepoBinder spawns the command directly, not through a shell.
- A command without path separators is looked up on `PATH`.
- A path-like command is any command that is absolute, starts with `.`, or contains `/` or `\`.
- Path-like commands must resolve inside the Primary Worktree when settings are saved.
- Path-like commands must exist when settings are saved.
- Relative path-like commands are resolved from the new Linked Worktree when setup runs.
- The command must be executable at runtime, or setup launch fails.

Prefer a repo-relative script path that exists in every Worktree, such as `scripts/repobinder-setup`. Avoid absolute script paths unless the project intentionally wants to run a script from the Primary Worktree while using the Linked Worktree as `cwd`.

Argument requirements:

- Arguments are argv entries, not shell text.
- Shell expansion, pipes, redirects, command substitution, and environment assignment syntax are not interpreted by RepoBinder.
- In the current UI, default args, shared run args, and row-specific args are entered one argument per non-empty line.
- When Auto Start Dev Server is enabled, RepoBinder rejects user-provided args containing `--port` or `--port=<number>`.

## Invocation Contract

RepoBinder invokes the Worktree Setup Script once per created Linked Worktree.

Invocation shape:

```text
<command> [...repository-default-args] [...shared-run-args] [...row-specific-args] [--port <reserved-port>]
```

Runtime details:

- Current working directory is the new Linked Worktree path.
- The script runs after `git worktree add` succeeds.
- RepoBinder provides stable context environment variables for the Primary Worktree, Linked Worktree, Branch, and Base Branch.
- The script does not receive the Branch name or Worktree Path as required positional arguments.
- The script may still discover Git context itself, for example with `git branch --show-current`, `pwd -P`, or `git rev-parse --show-toplevel`.
- Standard input is ignored.
- Standard output and standard error are captured.
- Setup has a 10 minute timeout.
- Captured stdout is limited to 256 KiB.
- Captured stderr is limited to 256 KiB.
- If timeout or output limits are exceeded, setup is marked failed.
- Setup scripts run sequentially within a New Worktree batch.
- RepoBinder allows only one global mutating operation at a time.

The setup process inherits the backend process environment and receives these stable RepoBinder context variables:

- `REPOBINDER_PRIMARY_WORKTREE_PATH`: absolute path to the Repository's Primary Worktree.
- `REPOBINDER_LINKED_WORKTREE_PATH`: absolute path to the newly created Linked Worktree where setup is running.
- `REPOBINDER_BRANCH`: Branch name created for the Linked Worktree.
- `REPOBINDER_BASE_BRANCH`: Branch name used as the Git base for `git worktree add`.

These variables are for paths and Git context only. RepoBinder does not pass secret values through environment variables.

## Required Script Behavior

A valid Worktree Setup Script should:

- Assume the Git Linked Worktree already exists.
- Treat the current working directory as the project root unless the repository layout requires otherwise.
- Verify it is running at the expected project root before mutating files.
- Install dependencies using the project's existing package manager and lockfile policy.
- Prepare generated files, local config, caches, or tool state needed for normal project development.
- Avoid destructive cleanup outside the Linked Worktree.
- Avoid printing secrets to stdout, stderr, metadata, URLs, warnings, or logs.
- Exit `0` for successful setup.
- Exit non-zero for failed setup, unless it intentionally exits `0` with metadata status `failed`.

Setup failure does not cause RepoBinder to delete the created Linked Worktree. RepoBinder keeps the Worktree Record with failed setup status so the user can inspect and repair it.

## Git Requirements

The script must not create the Linked Worktree. RepoBinder has already done that.

The script must not run these operations as part of the RepoBinder setup contract:

```text
git worktree add
git worktree remove
git branch -d
git branch -D
git checkout
git switch
git pull
git fetch
git merge
git rebase
```

Read-only Git commands are acceptable when they help setup discover context:

```text
git rev-parse --show-toplevel
git branch --show-current
git status --porcelain
```

The script should leave the requested Branch checked out in the Linked Worktree.

## Environment And Local Configuration

Many projects need ignored local files such as `.env`, `.env.local`, or app-specific runtime config files. Git worktree creation does not copy ignored files from the Primary Worktree.

A generated setup script should define an explicit project-specific strategy for these files. Acceptable strategies include:

- Copy from the Primary Worktree using `REPOBINDER_PRIMARY_WORKTREE_PATH`.
- Copy from a user-provided source path passed through Repository default args.
- Copy from a stable local template path inside the repository.
- Create a sample local file from committed example files such as `.env.example`.
- Fail with a clear warning or error if required local configuration is missing.
- Skip optional local configuration and report a warning.

Requirements:

- Preserve relative paths for monorepo app env files, such as `apps/web/.env.local`.
- Do not print file contents or secret values.
- Do not include secret values in metadata JSON.
- Do not overwrite an existing local env file unless the project explicitly requires that behavior.
- Prefer creating missing files over replacing user-edited files.
- Prefer copying whole local config files over passing individual secret values as args or metadata.

## Auto Start Dev Server

When Auto Start Dev Server is enabled, RepoBinder reserves one loopback port per Linked Worktree in the batch, starting at `3000` and scanning upward.

RepoBinder appends the reserved port after all configured args:

```text
--port <reserved-port>
```

If a project wants RepoBinder to open and later clean up Dev Servers, the setup script should support `--port <number>`.

When `--port` is present, the script should:

- Validate that the port value is an integer from `1` to `65535`.
- Check whether the port is still available immediately before starting the server.
- Start the Dev Server on that exact port.
- Wait until the Dev Server is listening before reporting success metadata.
- Bind to `127.0.0.1` or `localhost` unless the project has a specific safe reason not to.
- Return Dev Server metadata with the URL, port, and PID when available.
- Return process metadata for any long-running process RepoBinder should track and stop later.

RepoBinder checks ports before invoking setup, but the script must tolerate races where another process takes the port before the Dev Server starts.

If Auto Start Dev Server is disabled, users may still pass project-specific args. The script may start a Dev Server only when the project's own args say to do so.

## Output Contract

Stdout has special meaning.

The safest output policy is:

- Write progress logs to stderr.
- Write no stdout when there is no metadata to report.
- If metadata is needed, write exactly one JSON object to stdout.
- Do not write progress logs, banners, or multiple JSON objects to stdout.

RepoBinder parses setup stdout this way:

- Empty stdout and exit code `0`: setup succeeds with no metadata.
- Empty stdout and non-zero exit code: setup fails.
- Pure JSON object on stdout: RepoBinder parses setup metadata.
- Non-empty, non-JSON stdout and exit code `0`: setup succeeds, but RepoBinder records a warning that no metadata JSON was parsed.
- Non-zero exit code: setup fails even if metadata says `success`.
- Timeout or output truncation: setup fails.

Progress logs belong on stderr and should stay concise. Both stdout and stderr are capped at 256 KiB.

## Metadata JSON Schema

Metadata is optional. Use it when the script needs to report warnings, Dev Server state, or Tracked Processes.

Supported metadata shape:

```json
{
  "status": "success",
  "warnings": ["Optional setup step skipped"],
  "devServer": {
    "url": "http://localhost:3000",
    "port": 3000,
    "pid": 12345
  },
  "processes": [
    {
      "pid": 12345,
      "role": "dev_server",
      "primary": true,
      "command": "pnpm",
      "args": ["dev", "--host", "127.0.0.1", "--port", "3000"],
      "url": "http://localhost:3000",
      "port": 3000
    }
  ]
}
```

Field meanings:

- `status`: optional setup status. Allowed values are `success`, `warning`, and `failed`. Missing status defaults to `success`.
- `warnings`: optional array of non-secret warning strings.
- `devServer.url`: optional local URL for the primary Dev Server.
- `devServer.port`: optional Dev Server port.
- `devServer.pid`: optional Dev Server PID.
- `processes`: optional array of long-running process metadata.
- `processes[].pid`: required for a process entry; must be an integer greater than `1`.
- `processes[].role`: optional role. Allowed values are `setup`, `dev_server`, and `other`.
- `processes[].primary`: optional boolean. At most one process should be primary.
- `processes[].command`: optional command label.
- `processes[].args`: optional argv array.
- `processes[].url`: optional local URL associated with the process.
- `processes[].port`: optional port associated with the process.

Unknown fields are ignored.

Metadata requirements:

- Use `status` for setup state.
- Use `warnings` for warning text.
- Use `devServer` for primary Dev Server metadata.
- Use `processes` for long-running process metadata.
- Do not include secrets.

If both `devServer.pid` and `processes` are present, RepoBinder tracks the Dev Server PID even if it is not listed in `processes`.

If no process is marked primary, RepoBinder promotes the first `dev_server` process to primary.

## Dev Server URL Requirements

RepoBinder exposes Open Dev only when it knows a localhost URL or a port.

Prefer URLs like:

```text
http://localhost:3000
http://127.0.0.1:3000
```

Avoid non-local URLs in setup metadata. RepoBinder may store non-local metadata, but Open Dev is intended for localhost Dev Servers in this version.

If only `port` is reported, RepoBinder can derive:

```text
http://127.0.0.1:<port>
```

Before opening a Dev Server, RepoBinder verifies host-side TCP reachability. If the URL is not reachable, RepoBinder records a warning.

## Process Tracking Requirements

If the script starts long-running processes, return process metadata for the processes RepoBinder should later stop.

Requirements:

- Return positive integer PIDs greater than `1`.
- Prefer the actual listening server PID when it can be detected.
- If only a launcher PID is available, return the launcher PID.
- Start long-running processes from inside the Linked Worktree.
- Keep process output out of RepoBinder stdout after the setup script exits.
- Redirect long-running process logs to files inside the Linked Worktree or to `/dev/null`.
- Do not return PIDs for unrelated processes outside the Linked Worktree.

When using Bash with a reserved stdout descriptor for final JSON, close that descriptor for background processes. Otherwise the background process can inherit RepoBinder's stdout pipe and keep setup open.

Example pattern:

```bash
exec 3>&1
exec 1>&2

# Start a background process without inheriting descriptor 3.
(cd "$worktree_root" && pnpm dev --host 127.0.0.1 --port "$port" > .repobinder-dev.log 2>&1 3>&- & echo $! > .repobinder-dev.pid)
```

## Failure And Warning Behavior

Use a warning when setup is usable but not perfect:

```json
{
  "status": "warning",
  "warnings": ["Optional .env.local file was not found"]
}
```

Use failure when setup did not produce a usable project state:

```json
{
  "status": "failed",
  "warnings": ["Dependency installation failed"]
}
```

Failure options:

- Exit non-zero and write useful diagnostics to stderr.
- Exit `0` with metadata status `failed` when the script intentionally handled the failure and wants a structured setup result.

Non-zero exit always wins. If the script exits non-zero, RepoBinder marks setup failed even if metadata says `success`.

## Recommended Script Capabilities

A project-specific script generated from this document should usually do the following:

- Use `set -euo pipefail` for Bash scripts.
- Reserve stdout for metadata JSON.
- Send progress logs to stderr.
- Parse argv without relying on shell expansion.
- Support `--port <number>` if the project can start a Dev Server.
- Detect the Worktree root with `git rev-parse --show-toplevel`.
- Detect the Branch with `git branch --show-current`.
- Install dependencies using the repository's package manager.
- Prepare ignored local config files safely.
- Start a Dev Server only when requested by args.
- Emit metadata JSON only when reporting warnings, Dev Server metadata, or process metadata.
- Be safe to run manually from an existing Linked Worktree.

## Minimal No-Server Example

This is a contract example, not a drop-in script for every repository.

```bash
#!/usr/bin/env bash
set -euo pipefail

# stdout is reserved for optional RepoBinder metadata.
exec 3>&1
exec 1>&2

worktree_root="$(git rev-parse --show-toplevel)"
cd "$worktree_root"

echo "Installing dependencies in $worktree_root"

if [[ -f pnpm-lock.yaml ]]; then
  corepack pnpm install --frozen-lockfile
elif [[ -f package-lock.json ]]; then
  npm ci
elif [[ -f yarn.lock ]]; then
  corepack yarn install --immutable
fi

warnings=()

if [[ ! -f .env.local && -n "${REPOBINDER_PRIMARY_WORKTREE_PATH:-}" && -f "$REPOBINDER_PRIMARY_WORKTREE_PATH/.env.local" ]]; then
  install -m 600 "$REPOBINDER_PRIMARY_WORKTREE_PATH/.env.local" .env.local
  warnings+=("Copied .env.local from the Primary Worktree")
elif [[ ! -f .env.local && -f .env.example ]]; then
  cp .env.example .env.local
  warnings+=("Created .env.local from .env.example; fill in local secrets before running services")
fi

if (( ${#warnings[@]} > 0 )); then
  WARNINGS_JSON="$(printf '%s\n' "${warnings[@]}" | node -e 'const fs = require("node:fs"); const lines = fs.readFileSync(0, "utf8").trim().split(/\n/).filter(Boolean); process.stdout.write(JSON.stringify(lines));')"
  node - <<NODE >&3
process.stdout.write(JSON.stringify({
  status: "warning",
  warnings: $WARNINGS_JSON
}))
NODE
fi
```

## Minimal Dev Server Metadata Example

This example shows the shape of `--port` support and metadata reporting. Adapt the start command to the project.

```bash
#!/usr/bin/env bash
set -euo pipefail

exec 3>&1
exec 1>&2

port=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      port="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      exit 2
      ;;
  esac
done

worktree_root="$(git rev-parse --show-toplevel)"
cd "$worktree_root"

if [[ -f pnpm-lock.yaml ]]; then
  corepack pnpm install --frozen-lockfile
fi

if [[ -z "$port" ]]; then
  exit 0
fi

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "Invalid --port value: $port"
  exit 2
fi

port_reachable() {
  node - "$1" <<'NODE'
const net = require("node:net");
const port = Number(process.argv[2]);
const socket = net.connect({ host: "127.0.0.1", port }, () => {
  socket.destroy();
  process.exit(0);
});
socket.setTimeout(250);
socket.on("error", () => process.exit(1));
socket.on("timeout", () => {
  socket.destroy();
  process.exit(1);
});
NODE
}

if port_reachable "$port"; then
  echo "Port $port is already in use"
  exit 1
fi

log_file="$worktree_root/.repobinder-dev.log"
pid_file="$worktree_root/.repobinder-dev.pid"

(pnpm dev --host 127.0.0.1 --port "$port" > "$log_file" 2>&1 3>&- & echo $! > "$pid_file")
dev_pid="$(cat "$pid_file")"
url="http://localhost:$port"

server_ready=0
for _ in {1..40}; do
  if port_reachable "$port"; then
    server_ready=1
    break
  fi
  sleep 0.5
done

if [[ "$server_ready" != "1" ]]; then
  echo "Dev Server did not become reachable on port $port"
  exit 1
fi

node - <<NODE >&3
process.stdout.write(JSON.stringify({
  status: "success",
  devServer: {
    url: "$url",
    port: Number("$port"),
    pid: Number("$dev_pid")
  },
  processes: [
    {
      pid: Number("$dev_pid"),
      role: "dev_server",
      primary: true,
      command: "pnpm",
      args: ["dev", "--host", "127.0.0.1", "--port", "$port"],
      url: "$url",
      port: Number("$port")
    }
  ]
}))
NODE
```

## LLM Generation Checklist

When asking an LLM to generate a Worktree Setup Script for a project, require it to satisfy this checklist:

- [ ] The script is repository-owned and committed to the project.
- [ ] The configured command is a repo-relative path such as `scripts/repobinder-setup`.
- [ ] The script assumes `cwd` is the new Linked Worktree.
- [ ] The script uses `REPOBINDER_PRIMARY_WORKTREE_PATH` when it needs ignored local files from the Primary Worktree.
- [ ] The script treats `REPOBINDER_LINKED_WORKTREE_PATH`, `REPOBINDER_BRANCH`, and `REPOBINDER_BASE_BRANCH` as context, not as secrets.
- [ ] The script does not create, delete, fetch, pull, switch, merge, or rebase Git worktrees or Branches.
- [ ] The script stays within the Worktree Setup Script responsibility boundary.
- [ ] The script uses stderr for logs.
- [ ] The script emits either empty stdout or pure metadata JSON.
- [ ] The script keeps stdout and stderr comfortably below 256 KiB each.
- [ ] The script exits within 10 minutes.
- [ ] The script handles missing optional local config with warnings.
- [ ] The script never prints secrets.
- [ ] The script supports `--port <number>` if Auto Start Dev Server should be used.
- [ ] The script waits for a started Dev Server to become reachable before reporting success metadata.
- [ ] The script returns localhost Dev Server metadata when it starts a server.
- [ ] The script returns valid PIDs for long-running processes RepoBinder should stop later.
- [ ] Background processes do not inherit RepoBinder stdout.
- [ ] The script is safe to rerun manually inside a Linked Worktree.

## Implementation References

The contract above is derived from the current RepoBinder implementation:

- `CONTEXT.md`
- `.scratch/repobinder-desktop-dashboard/PRD.md`
- `apps/server/src/lib/request.ts`
- `apps/server/src/routes/linked-worktrees.ts`
- `apps/server/src/setup/run.ts`
- `apps/server/src/setup/metadata.ts`
- `apps/server/src/setup/status.ts`
- `apps/server/src/routes/worktree-status.ts`
- `apps/server/src/store.ts`
