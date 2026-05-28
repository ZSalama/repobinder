# Workspace Script Requirements

repobinder creates new workspaces by running a repo-owned executable script from the desktop app's main process. The default configured script path is `new_workspace`, relative to the parent repository root.

This document describes the contract the script must satisfy for repobinder to create, register, use, and later delete a workspace successfully.

## Purpose

The workspace script is responsible for preparing a new local Git worktree for a requested branch. repobinder does not create the worktree itself. It validates the script location, invokes the script, parses its final JSON result, then registers the returned worktree as a runnable workspace.

The usual script responsibilities are:

- Validate or create the requested branch.
- Create a Git worktree for that branch.
- Install dependencies or run any project bootstrap steps required before an agent can work.
- Optionally start long-running workspace processes such as a dev server or Convex dev server.
- Print a final JSON object describing the result.

## App Workflow

The desktop and web apps both feed into the same desktop IPC path:

1. A user selects a parent repository and enters one to five branch names plus optional script args.
2. The desktop app validates the branch names and configured script path.
3. The desktop app runs the script once per requested branch.
4. For each successful script result, repobinder validates the returned `workspacePath` as a Git worktree.
5. repobinder registers the worktree as a new repo entry linked back to the parent repository.
6. repobinder records any returned process PIDs for later cleanup.
7. The new workspace becomes selectable for Codex runs, with Codex launched from the worktree root.

Remote branch requests created in the web app are queued in Convex, claimed by the desktop app, then executed through the same script runner.

## Script Location

The script path is stored per repository as `workspaceScriptPath`.

Requirements:

- The path must be repo-relative, not absolute.
- The path must resolve inside the parent repository root after symlink resolution.
- The target must exist.
- The target must be an executable file.
- The default path for new repos is `new_workspace`.

Examples:

- Valid: `new_workspace`
- Valid: `scripts/new_workspace`
- Invalid: `/home/user/repo/new_workspace`
- Invalid: `../new_workspace`
- Invalid: a non-executable file

Parent repositories can be configured even when the script is missing, but running the script will fail until the path exists and is executable.

## Invocation Contract

repobinder invokes the script directly with `spawn`, not through a shell:

```text
<repo>/<workspaceScriptPath> <branchName> [...scriptArgs]
```

Runtime details:

- Current working directory is the parent repository root.
- `argv[1]` is always the requested branch name.
- Additional arguments come from the repo's default script args or the per-run script args field.
- If Auto start dev environment is enabled, repobinder appends `--port <number>` after the configured additional arguments.
- Additional args are parsed from a shell-like text field supporting spaces, single quotes, double quotes, and backslash escapes.
- The script receives argv entries directly; shell expansion, pipes, redirects, environment assignments, and command substitution are not applied by repobinder.
- Standard input is ignored.
- Standard output and standard error are captured.
- The script has a 10 minute timeout.
- Stdout and stderr are each limited to 256 KiB.
- Only one workspace script run may be active in the desktop app at a time.
- Batch creation supports 1 to 5 workspaces; repobinder runs the script sequentially once per requested branch.

Branch names are validated by repobinder with:

```text
git check-ref-format --branch <branchName>
```

The script should still defensively handle branch conflicts, existing worktrees, and project-specific naming rules.

## Auto Dev Port Mode

The New workspace dialog includes an Auto start dev environment option. When enabled, repobinder allocates a currently available loopback port and appends it to each workspace script invocation:

```text
<repo>/<workspaceScriptPath> <branchName> [...scriptArgs] --port <allocatedPort>
```

Auto dev allocation starts at port `3000` and scans upward, skipping ports that are already listening and ports already reserved for other workspaces in the same batch. Batch creation still runs each script sequentially.

Scripts that want users to automatically spin up new dev environments must support:

```text
--port <number>
```

When `--port` is present, the script should:

- Start the dev environment on that exact port.
- Return `port` in the final JSON result.
- Return `url` when the local URL is known, for example `http://localhost:3000`.
- Return `processes.dev` for the long-running dev server process repobinder should track and clean up.

repobinder probes the port before invoking the script, but the script must still validate the port immediately before starting the dev server. Another process can claim the port between repobinder's probe and the script's server startup.

Manual port workflows are still supported. If Auto start dev environment is disabled, users may provide `--port <number>` or other repo-specific arguments themselves. If Auto start dev environment is enabled, repobinder rejects script args that already contain `--port` or `--port=<number>` to avoid ambiguous invocations.

## Required Success Behavior

For repobinder to register the created workspace, all of the following must be true:

- The script exits with code `0`.
- Stdout ends with a valid JSON object.
- The JSON object includes `"ok": true`.
- The JSON object includes `"agentRunnable": true`.
- The JSON object includes a non-empty `"workspacePath"`.
- `workspacePath` resolves to a Git repository root.
- `workspacePath` is a Git worktree, not the parent repository's main worktree.

repobinder validates the returned `workspacePath` by resolving the real path, checking `git rev-parse --show-toplevel`, and requiring `git rev-parse --git-dir` to differ from `git rev-parse --git-common-dir`.

If the script returns `ok: true` but omits `agentRunnable: true` or `workspacePath`, repobinder will not register a new workspace and will keep the selected repo on the source repository.

## Output JSON Contract

The final stdout content must be a JSON object. The safest approach is to print normal progress logs to stderr and print only the final JSON object to stdout.

repobinder first tries to parse all trimmed stdout as JSON. If that fails, it tries to parse the final JSON object beginning at the last `{` in stdout. Because that fallback is intentionally simple, avoid printing other JSON objects to stdout before the result.

A robust Bash pattern is to preserve the original stdout for JSON, redirect normal stdout to stderr, and emit the final result through the saved stdout descriptor:

```bash
exec 3>&1
exec 1>&2

# progress logs now go to stderr
echo "Creating worktree..."

# final JSON goes to original stdout
node - <<'NODE' >&3
process.stdout.write(JSON.stringify({ ok: true, agentRunnable: true, branchName: "agent/test" }))
NODE
```

For production scripts, prefer a JSON encoder such as `node`, `python3`, or `jq` over hand-built JSON strings. This avoids broken output when paths, branch names, or error messages contain quotes, backslashes, or newlines.

Supported result fields:

```json
{
  "ok": true,
  "agentRunnable": true,
  "repoPath": "/absolute/path/to/parent/repo",
  "workspacePath": "/absolute/path/to/worktree",
  "workspaceName": "repo-agent-test",
  "branchName": "agent/test",
  "baseBranch": "main",
  "port": 3001,
  "url": "http://localhost:3001",
  "logs": {
    "workspace": "/absolute/path/to/workspace.log",
    "dev": "/absolute/path/to/dev.log",
    "convex": "/absolute/path/to/convex.log"
  },
  "processes": {
    "dev": 12345,
    "convex": 12346
  }
}
```

Field meanings:

- `ok`: Must be exactly `true` for success. Any other value is treated as false.
- `agentRunnable`: Must be exactly `true` for repobinder to register the workspace for agent runs.
- `workspacePath`: Required for registration. Prefer an absolute path to the created worktree root.
- `workspaceName`: Optional display name for the new workspace. If omitted, repobinder uses the basename of `workspacePath`.
- `branchName`: Optional normalized branch name. If omitted, repobinder uses the requested branch name.
- `repoPath`: Optional parent repo path. If omitted, repobinder uses the configured source repo path.
- `baseBranch`: Optional metadata.
- `port`: Optional numeric metadata.
- `url`: Optional metadata.
- `logs.workspace`, `logs.dev`, `logs.convex`: Optional string paths or labels.
- `processes.dev`, `processes.convex`: Optional numeric PIDs for long-running processes repobinder should track and clean up.
- `failureStep`: Optional failure category for unsuccessful results.
- `errorMessage`: Optional human-readable failure message for unsuccessful results.

Unknown fields are ignored. Empty strings are ignored for string fields.

## Failure Behavior

On failure, the script should exit non-zero and write a useful error to stderr, or exit zero with a structured failure JSON.

Recommended structured failure:

```json
{
  "ok": false,
  "agentRunnable": false,
  "branchName": "agent/test",
  "failureStep": "worktree_create",
  "errorMessage": "Branch already has a checked-out worktree."
}
```

repobinder also creates its own failures for:

- Missing or empty branch name.
- Invalid Git branch name.
- Invalid script path.
- Script launch failure.
- Timeout after 10 minutes.
- Stdout or stderr over 256 KiB.
- Non-zero script exit.
- Missing or invalid result JSON.
- Returned workspace path failing worktree validation.
- Another workspace script already running.

For non-zero exits, repobinder surfaces trimmed stderr, up to 2000 characters.

A production script should track the current setup step and emit structured failure JSON from an `EXIT` trap. That gives the desktop app a useful `failureStep` and `errorMessage` even when an ordinary command fails under `set -e`.

Useful step names are short machine-readable strings such as `discoverRepo`, `checkWorkspaceTarget`, `checkBranchAvailability`, `fetchRemoteRefs`, `resolveBaseBranch`, `pullBaseBranch`, `checkPort`, `createWorktree`, `copyWorkspaceEnv`, `installDependencies`, `startDevServer`, `initializeConvexLocal`, and `syncConvexEnv`.

If a non-critical optional capability cannot be prepared, the script may still return `ok: true` with `agentRunnable: false`. Use this only when the workspace was created but should not yet be selected for agent work.

## Git Worktree Requirements

The returned workspace must be a worktree associated with the source repository. A typical implementation is:

```bash
git fetch --all --prune
git worktree add -b "$branch_name" "$workspace_path" "$base_ref"
```

The exact branch policy is project-specific, but the result must satisfy:

- The worktree folder exists.
- The worktree folder is the Git top-level directory.
- The branch is checked out in that worktree.
- The parent repository remains the configured source repo.
- The branch name returned in JSON matches the actual branch repobinder should display and later delete.

repobinder's delete workflow assumes a registered workspace is a Git worktree. It removes the worktree, prunes worktree metadata, and then deletes the associated branch from the source repository.

## Workspace Naming

The Git branch name and the workspace folder name are separate concerns. The branch name should remain the exact requested branch, but the folder suffix should be sanitized so branch separators, spaces, punctuation, and uppercase letters do not create awkward or unsafe paths.

A proven folder slug pattern is:

```bash
SAFE_BRANCH_NAME="$(
  printf '%s' "$BRANCH_NAME" \
    | tr '[:upper:]_' '[:lower:]-' \
    | sed -E 's#[^a-z0-9-]+#-#g; s#^-+##; s#-+$##; s#-+#-#g'
)"

if [[ -z "$SAFE_BRANCH_NAME" ]]; then
  fail "branch_name must contain at least one letter or number for workspace naming"
fi

NEW_FOLDER_NAME="${PROJECT_NAME}-${SAFE_BRANCH_NAME}"
NEW_WORKSPACE="${PROJECT_PARENT}/${NEW_FOLDER_NAME}"
```

This turns a branch such as `agent/ui-fix` into a sibling folder such as `my-project-agent-ui-fix`, while preserving `agent/ui-fix` as the actual Git branch.

Before creating the worktree, the script should fail if the target folder already exists. It should also check for existing local and remote branches with the requested branch name, because `git worktree add -b` will fail later and can leave more ambiguous logs.

## Environment Files

For typical repobinder workspaces, the script should copy local runtime env files into the worktree after it is created:

```bash
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  cp "$PROJECT_ROOT/.env" "$NEW_WORKSPACE/.env"
fi

if [[ -f "$PROJECT_ROOT/.env.local" ]]; then
  cp "$PROJECT_ROOT/.env.local" "$NEW_WORKSPACE/.env.local"
fi

if [[ -f "$PROJECT_ROOT/.agent.clerk.env" ]]; then
  cp "$PROJECT_ROOT/.agent.clerk.env" "$NEW_WORKSPACE/.agent.clerk.env"
fi
```

This lets agents and optional dev servers run against a workspace that behaves like the parent repo without requiring users to recreate secrets or local config manually.

Monorepos commonly have scoped env files such as `apps/web/.env.local` or `apps/desktop/.env.local`; make sure every required `.env*` file is copied while preserving its relative path, not only root-level env files.

Keep these rules in mind:

- Copy env files locally, but do not print their contents in logs or result JSON.
- Do not return secret values through `logs`, `url`, `errorMessage`, or any other JSON field.
- If the script starts an isolated local Convex deployment, remove cloud Convex values from copied env files before initialization. At minimum, remove `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, and `CONVEX_URL`.
- If local Convex needs selected runtime env vars, sync only the required keys into the local deployment instead of bulk-printing or exposing the full env.

Useful workspace-local metadata file names:

- `.agent.env`: optional non-secret dev server metadata such as `PORT`, `URL`, `WORKSPACE`, `BRANCH`, `PROJECT_ROOT`, `PID_FILE`, and `LOG_FILE`.
- `.agent.pid`: optional frontend dev server PID.
- `.agent.dev.log`: optional frontend dev server log.
- `.agent.convex.pid`: optional local Convex PID.
- `.agent.convex.log`: optional local Convex log.
- `.agent.workspace.log`: optional setup log copied from a temp log after the worktree exists.

## Process Tracking Requirements

If the script starts long-running processes, return their PIDs in `processes.dev` and/or `processes.convex`.

repobinder only tracks returned PIDs that:

- Are positive integers greater than `1`.
- Are still running when the script exits.
- Have a current working directory inside the returned `workspacePath`, or have no readable cwd.

Tracked processes and their descendants are terminated when the workspace is deleted or when the desktop app quits. Processes outside the workspace path are intentionally not tracked.

If the script does not start long-running processes, omit `processes`.

For dev servers, the launcher process is not always the process that listens on the requested port. A better pattern is to start the server from inside the workspace, write the launcher PID, then detect the listening PID with `ss` or `lsof` and return that PID if available. Validate ports before starting servers and fail early if the port is already in use.

When a Bash script reserves a separate stdout descriptor for the final JSON result, close that descriptor for any background process. For example, use `3>&-` on a detached dev server command. Otherwise the background process can inherit repobinder's stdout pipe after the script exits, which leaves the desktop app waiting for the workspace script to finish.

## Agent Run Requirements

After registration, repobinder runs Codex with:

```text
cwd = <registered workspacePath>
codex exec --json -o <last-message-file> <prompt>
```

Therefore the script should leave the workspace in a state where:

- The requested branch is checked out.
- The repository root is ready as the agent working directory.
- Required files, dependencies, environment files, generated code, or local services expected by agents are prepared.
- Any generated or copied secrets stay local and are not printed in stdout/stderr or returned JSON.

## Minimal Example Shape

This is a contract example, not a drop-in script for every repo:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Keep stdout reserved for repobinder's final JSON result.
exec 3>&1
exec 1>&2

branch_name="${1:?branch name is required}"
shift || true

repo_path="$(git rev-parse --show-toplevel)"
base_branch="${BASE_BRANCH:-main}"
default_workspace_root="$(dirname "$repo_path")"
workspace_root="${REPOBINDER_WORKSPACE_ROOT:-$default_workspace_root}"
safe_name="$(
  printf '%s' "$branch_name" \
    | tr '[:upper:]_' '[:lower:]-' \
    | sed -E 's#[^a-z0-9-]+#-#g; s#^-+##; s#-+$##; s#-+#-#g'
)"
if [[ -z "$safe_name" ]]; then
  echo "branch name must contain at least one letter or number for workspace naming"
  exit 1
fi
workspace_path="${workspace_root}/$(basename "$repo_path")-${safe_name}"

export REPOBINDER_BRANCH_NAME="$branch_name"
export REPOBINDER_REPO_PATH="$repo_path"
export REPOBINDER_WORKSPACE_PATH="$workspace_path"
export REPOBINDER_BASE_BRANCH="$base_branch"
export REPOBINDER_WORKSPACE_NAME="$(basename "$workspace_path")"

if [[ -e "$workspace_path" ]]; then
  python3 - <<'PY' >&3
import json
import os
print(json.dumps({
  "ok": False,
  "agentRunnable": False,
  "branchName": os.environ["REPOBINDER_BRANCH_NAME"],
  "failureStep": "worktree_exists",
  "errorMessage": "Workspace path already exists."
}))
PY
  exit 0
fi

git fetch --all --prune >&2
git worktree add -b "$branch_name" "$workspace_path" "$base_branch" >&2

if [[ -f "$repo_path/.env" ]]; then
  cp "$repo_path/.env" "$workspace_path/.env"
fi

if [[ -f "$repo_path/.env.local" ]]; then
  cp "$repo_path/.env.local" "$workspace_path/.env.local"
fi

if [[ -f "$repo_path/.agent.clerk.env" ]]; then
  cp "$repo_path/.agent.clerk.env" "$workspace_path/.agent.clerk.env"
fi

(
  cd "$workspace_path"
  # Repo-specific setup goes here, for example:
  # pnpm install --frozen-lockfile >&2
)

python3 - <<'PY' >&3
import json
import os
print(json.dumps({
  "ok": True,
  "agentRunnable": True,
  "repoPath": os.environ["REPOBINDER_REPO_PATH"],
  "workspacePath": os.environ["REPOBINDER_WORKSPACE_PATH"],
  "workspaceName": os.environ["REPOBINDER_WORKSPACE_NAME"],
  "branchName": os.environ["REPOBINDER_BRANCH_NAME"],
  "baseBranch": os.environ["REPOBINDER_BASE_BRANCH"]
}))
PY
```

If using Bash only, be careful to JSON-escape paths and branch names correctly. Using `python3`, `node`, or another JSON encoder for the final result is safer than hand-building JSON.

## Implementation References

The contract above is derived from:

- `apps/desktop/src/main/services/workspaceScript.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/services/convexRepoStore.ts`
- `apps/desktop/src/main/services/repoSyncMetadata.ts`
- `apps/desktop/src/main/services/deleteWorkspace.ts`
- `apps/desktop/src/main/services/processTracking.ts`
- `packages/shared/src/repobinder.ts`
- `convex/branchRequests.ts`
