Status: ready-for-agent

# RepoBinder Worktree Dashboard PRD

## Problem Statement

RepoBinder currently has the early shape of a worktree tool, but it still carries legacy Deskbinder concepts such as "workspace," Codex-oriented setup, browser `localStorage` persistence, and a one-off repository path flow. The target product is a focused repository dashboard for managing local Git worktrees attached to local repositories.

Developers need a compact way to add a Primary Worktree, see the Linked Worktrees that RepoBinder manages, create new Linked Worktrees from a known Base Branch, optionally run repository-owned setup, open local Dev Servers, open terminals, and safely delete Linked Worktrees without risking the Primary Worktree.

## Solution

Build a dark, responsive, two-pane RepoBinder dashboard backed by the shared local HTTP backend described in ADR-0001. Electron remains the desktop supervisor, and the browser UI continues to talk to the backend API. Native desktop-only features, such as folder picking and terminal launch, use a small desktop bridge rather than replacing the shared API with broad Electron IPC.

RepoBinder will persist Repository Records, Worktree Records, Repository Settings, Tracked Processes, and Operation Records in a backend-owned local JSON store. The React UI will no longer persist repository selection in browser `localStorage`.

The main dashboard is Repository-centric. The sidebar selects a Repository group and may highlight a Worktree inside that group, but the main surface continues to show all Tracked Worktrees for the Selected Repository. RepoBinder does not automatically discover untracked Git worktrees. It shows Worktrees only when the user adds a Repository, creates a Linked Worktree through RepoBinder, or explicitly adds an existing Linked Worktree.

## User Stories

1. As a local developer, I want the application to be named RepoBinder everywhere, so that I do not see legacy Deskbinder branding.
2. As a local developer, I want the app to use Worktree terminology, so that the UI matches Git concepts clearly.
3. As a local developer, I want a dark, compact, work-focused dashboard, so that I can manage repositories without a marketing-style interface.
4. As a local developer, I want a left sidebar of Repository groups, so that I can switch between managed repositories quickly.
5. As a local developer, I want Repository groups to show nested Worktrees, so that I can orient myself by Branch and Worktree status.
6. As a local developer, I want the main dashboard to stay Repository-centric, so that I can compare all Tracked Worktrees for the Selected Repository.
7. As a local developer, I want selecting a Linked Worktree in the sidebar to highlight it in the main view, so that selection does not hide the rest of the Repository context.
8. As a local developer, I want RepoBinder to restore my last selected Repository and Worktree when possible, so that returning to the app is fast.
9. As a local developer, I want RepoBinder to select the first available Repository when the last selection is gone, so that startup still lands somewhere useful.
10. As a local developer, I want a "Choose a Repository" empty state when nothing is selected, so that the app is clear before setup.
11. As a local developer, I want a centered loading state while local config loads, so that the app does not show a misleading empty dashboard.
12. As a local developer, I want a full-page bridge/backend failure state, so that startup failures are easy to understand.
13. As a desktop user, I want Add Repository to open a native folder picker, so that I can choose a Primary Worktree without typing paths.
14. As a desktop user, I want Add Repository to accept only a Primary Worktree path, so that Linked Worktrees are not registered as parent repositories.
15. As a desktop user, I want Add Repository to reject non-Git paths, bare repositories, nested subdirectories, and Linked Worktrees, so that Repository Records remain valid.
16. As a desktop user, I want Add Repository to select the newly added Repository, so that I can immediately manage it.
17. As a desktop user, I want Add Repository to create a Primary Worktree Record, so that the Primary Worktree appears in the same list as Linked Worktrees.
18. As a desktop user, I want adding the same Primary Worktree again to select the existing Repository, so that duplicates are avoided.
19. As a browser or remote user, I do not want Add Repository exposed, so that remote clients cannot add arbitrary host paths.
20. As a browser or remote user, I want to create and delete RepoBinder-managed Linked Worktrees, so that remote mode can operate on known managed records.
21. As a browser or remote user, I want a persistent trusted-network warning in remote mode, so that I understand remote mutation is not safe for untrusted networks yet.
22. As a user, I want Repository Settings to configure setup behavior, so that each Repository can have its own setup command and default args.
23. As a user, I want Repository Settings to allow setup to be disabled, so that basic Git worktree creation does not require a script.
24. As a user, I want setup configuration saved as command plus argument arrays, so that RepoBinder avoids shell parsing ambiguity.
25. As a user, I want setup configuration validated on save, so that invalid setup commands fail early.
26. As a user, I want a Repository Settings action to add an existing Linked Worktree manually, so that RepoBinder can track worktrees I created outside the app.
27. As a user, I want Add Existing Worktree to validate that the path is attached to the selected Repository, so that cross-repository mistakes are rejected.
28. As a user, I want Add Existing Worktree not to run setup, so that manually prepared Worktrees are not mutated unexpectedly.
29. As a user, I want a New Worktree button for each Selected Repository, so that I can create Linked Worktrees from that Repository.
30. As a user, I want New Worktree to require the Primary Worktree to have a checked-out Branch, so that RepoBinder can choose a clear Base Branch.
31. As a user, I want New Worktree to show the Base Branch, so that I know what my new Branches start from.
32. As a user, I want New Worktree to use the Branch currently checked out in the Primary Worktree as the default Base Branch, so that the flow matches my current Repository context.
33. As a user, I want one shared Base Branch per New Worktree submission, so that the batch stays simple and predictable.
34. As a user, I want to choose 1 to 5 Linked Worktrees in one batch, so that I can prepare parallel work quickly.
35. As a user, I want the first Branch name to be required, so that auto-generated names have a source.
36. As a user, I want empty additional Branch names to become `-2`, `-3`, and later suffixes, so that batch creation is quick.
37. As a user, I want all Branch names validated before creation starts, so that invalid input does not create partial Git state.
38. As a user, I want the New Worktree flow to always create new Branches, so that the first version avoids existing-Branch checkout conflicts.
39. As a user, I want RepoBinder not to fetch or pull automatically before creating a Linked Worktree, so that it does not surprise me with network Git operations.
40. As a user, I want RepoBinder to allow creation when the Primary Worktree has uncommitted changes, so that local edits do not block creating a new Branch.
41. As a user, I want a warning when the Primary Worktree is dirty, so that I know uncommitted changes will not be copied into the new Linked Worktree.
42. As a user, I want RepoBinder to generate Worktree Paths automatically, so that I do not need to type filesystem paths for new Linked Worktrees.
43. As a user, I want generated Worktree Paths to be adjacent to the Primary Worktree and based on the Branch slug, so that local folders are predictable.
44. As a user, I want RepoBinder to fail validation if a generated Worktree Path already exists, so that stale folders are not hidden by auto-incremented names.
45. As a user, I want generated paths checked against all non-deleted Worktree Records, so that two records cannot point to the same location.
46. As a user, I want setup scripts to run only after RepoBinder creates the Git worktree, so that Git state remains controlled by RepoBinder.
47. As a user, I want setup scripts to handle only post-creation work, so that scripts can install dependencies, copy env files, or start Dev Servers without owning Git worktree creation.
48. As a user, I want setup script metadata to be optional, so that simple repositories can use no script or scripts with no JSON output.
49. As a user, I want setup failures not to delete the created Linked Worktree automatically, so that I can inspect and fix the result.
50. As a user, I want setup warnings to be recorded without failing Worktree creation, so that non-critical setup issues are visible.
51. As a user, I want Auto Start Dev Server to pass `--port <port>` to the setup script, so that repository-owned tooling starts the project server.
52. As a user, I want Auto Start Dev Server disabled when setup is disabled, so that RepoBinder does not pretend it can start arbitrary project servers.
53. As a user, I want RepoBinder to reserve ports for the whole batch starting at 3000, so that each row has a planned unique port.
54. As a user, I want RepoBinder to reject user-provided `--port` args when Auto Start Dev Server is enabled, so that invocation is unambiguous.
55. As a user, I want setup scripts to run sequentially, so that batch behavior and logs are predictable.
56. As a user, I want only one global mutating operation at a time, so that JSON store and Git operations stay simple and safe.
57. As a user, I want manual refresh disabled during mutation, so that intermediate Git state does not confuse the dashboard.
58. As a user, I want Open Dev and Open Terminal to remain available for rows not being mutated, so that non-conflicting actions stay useful.
59. As a user, I want partial runtime success in a batch to be summarized, so that I know exactly which Linked Worktrees were created and which setup runs failed.
60. As a user, I want the first successfully created Linked Worktree selected after a batch, so that I can continue from the useful result.
61. As a user, I want the Worktree list to be dense rather than card-heavy, so that I can scan Branches, paths, statuses, and actions efficiently.
62. As a user, I want Worktree rows to show Branch, type, Worktree Path, setup status, Dev Server status, and actions, so that the core facts are visible.
63. As a user, I want Primary Worktree deletion disabled, so that RepoBinder cannot remove the parent checkout.
64. As a user, I want Linked Worktree deletion available from the row, so that cleanup is close to the item being removed.
65. As a user, I want delete to use a normal confirmation dialog, so that destructive operations are guarded without excessive friction.
66. As a user, I want delete to show separate consequences for removing the Worktree Path and deleting the Branch, so that I understand the operation.
67. As a user, I want Branch deletion defaulted on for RepoBinder-created Linked Worktrees, so that cleanup matches the creation flow.
68. As a user, I want Branch deletion defaulted off for manually added existing Linked Worktrees, so that externally created Branches are preserved unless I opt in.
69. As a user, I want Branch deletion to use Git's safe delete behavior by default, so that unmerged work is protected.
70. As a user, I want deletion to use `git worktree remove`, so that Git remains the source of truth for physical worktree removal.
71. As a user, I want deletion to stop Tracked Processes before removing a Linked Worktree, so that dev servers do not keep stale paths or ports alive.
72. As a user, I want process stopping to terminate process trees with graceful then forceful behavior, so that child processes are cleaned up.
73. As a user, I want deletion results summarized, so that branch deletion failures or process cleanup failures are visible.
74. As a user, I want deleted Worktree Records soft-deleted, so that RepoBinder keeps internal history without showing stale rows.
75. As a user, I want deleting the selected Linked Worktree to select the Primary Worktree afterward, so that the Repository remains selected.
76. As a user, I want unavailable stored Worktree Records to show warnings instead of disappearing, so that missing paths are not silently hidden.
77. As a user, I want locked or prunable Git worktree state shown as row warnings, so that Git-level issues are visible.
78. As a user, I want refresh on startup, after mutations, on focus, and via a manual button, so that state stays current without aggressive polling.
79. As a user, I want selected Repository process and Dev Server status to poll lightly, so that the UI notices stale Dev Servers.
80. As a user, I want PID state treated carefully when the PID cannot be verified, so that PID reuse does not produce false confidence.
81. As a user, I want Open Dev shown when a local URL or port is known, so that I can open the Worktree's primary Dev Server.
82. As a user, I want Open Dev to verify reachability from the RepoBinder host, so that clearly dead Dev Servers are flagged.
83. As a user, I want Open Dev to allow only localhost URLs in this PRD, so that repository scripts cannot turn RepoBinder into an arbitrary URL launcher.
84. As a remote browser user, I want Open Dev to open in my browser client, so that browser mode still exposes the action even if host-local `localhost` may not connect remotely.
85. As a user, I want Open Dev failures recorded as warnings, so that failed launches can be diagnosed.
86. As a user, I do not want successful Open Dev actions recorded, so that recent activity stays focused.
87. As a desktop user, I want Open Terminal for every Tracked Worktree, so that I can jump to either the Primary Worktree or a Linked Worktree.
88. As a remote browser user, I do not want Open Terminal exposed, so that remote mode does not launch a terminal on the host.
89. As a user, I want Open Terminal failures recorded, so that launch problems are diagnosable.
90. As a user, I want success and info banners to auto-dismiss quickly, so that the dashboard stays tidy.
91. As a user, I want warning and error banners to auto-dismiss more slowly, so that I have time to read them.
92. As a user, I want recent Operation Records available in an activity details view, so that auto-dismissed failures are recoverable.
93. As a user, I want recent Operation Records persisted with a retention limit, so that diagnostics survive restart without becoming a full audit log.
94. As a user, I want setup logs captured with limits, so that diagnostics are useful without growing unbounded.
95. As a user, I want setup output details available from the batch result, so that I can inspect stdout, stderr, exit code, duration, warnings, and parsed metadata.
96. As a user, I want a responsive mobile layout, so that browser mode remains usable on smaller screens.
97. As a mobile user, I want the sidebar collapsed into a sheet, so that Repository navigation does not consume the whole viewport.
98. As a mobile user, I want Worktree rows stacked without horizontal scrolling, so that I can operate on Worktrees from a phone-sized viewport.
99. As a mobile browser user, I want create and delete to remain available, so that remote browser mode is not view-only on mobile.
100. As a keyboard user, I want dialogs, tables/lists, buttons, and row actions to be keyboard accessible, so that the dashboard works without a mouse.
101. As a keyboard user, I want visible focus states and labels for icon-only actions, so that controls are understandable.
102. As a user, I accept that status may be conveyed by color alone, so that the UI can stay compact.
103. As a maintainer, I want the old workspace/Codex language removed, so that future work does not reintroduce Deskbinder scope.
104. As a maintainer, I want no Codex integration in RepoBinder, so that the product remains focused on Git worktree management.
105. As a maintainer, I want no old browser `localStorage` Repository persistence, so that the backend local store is authoritative.

## Implementation Decisions

- Use the canonical product name RepoBinder. Deskbinder is legacy language and should not appear in the product UI.
- Use Worktree, Primary Worktree, Linked Worktree, Branch, Base Branch, Repository Record, Worktree Record, Tracked Worktree, Worktree Setup Script, Dev Server, Tracked Process, Soft-Deleted Record, and Operation Record consistently.
- Keep ADR-0001's architecture: Electron supervises the local backend and loads the same React app served by that backend.
- Keep the backend HTTP API as the primary app API for desktop and browser clients.
- Add only a narrow desktop bridge for native-only capabilities: native folder picker, terminal launch, and desktop external opening behavior where required.
- Store app state in a backend-owned local JSON store, not browser `localStorage`.
- Store the local JSON store in the OS app data directory for Electron desktop. Server-only mode may use a configurable data directory.
- Use a store filename such as `repobinder-store.json`.
- Include a schema version in the JSON store and a startup migration path, even for the initial schema.
- Do not migrate old browser `localStorage` repository paths.
- Remove old browser persistence keyed by `repobinder.repositoryPath`.
- Repository Records have generated local `repositoryId` values.
- Repository duplicate detection uses the resolved real path of the Primary Worktree plus Git common dir.
- Worktree Records have generated local `worktreeId` values.
- Worktree Records store resolved real Worktree Path, Branch name when present, parent `repositoryId`, type (`primary` or `linked`), provenance, availability, setup status, Dev Server metadata, Tracked Processes, and soft-delete state.
- Worktree duplicate detection uses resolved real Worktree Path plus Git common dir.
- A Primary Worktree is represented as a Worktree Record with type `primary` and deletion disabled.
- A Linked Worktree can be created by RepoBinder or manually added as an existing Worktree.
- Track Worktree provenance with a flag such as `createdByRepoBinder`.
- Soft-delete means setting a deletion timestamp and hiding the record from normal lists.
- Do not include Repository removal in this PRD.
- Do not automatically discover untracked Git worktrees.
- Add Existing Worktree is explicit and validates the selected path is a Linked Worktree attached to the Selected Repository's Git common dir.
- Add Existing Worktree does not run a Worktree Setup Script.
- Once an existing Linked Worktree is explicitly tracked, RepoBinder may delete it later through the normal Linked Worktree delete flow.
- Sidebar parent rows represent Repositories. Nested rows represent Worktrees.
- Selecting a Repository changes the main dashboard.
- Selecting a Worktree highlights it inside the Selected Repository without replacing the Repository-centric dashboard.
- Startup selection restores the last selected non-deleted Repository and Worktree when possible, otherwise selects the first non-deleted Repository, otherwise shows the empty state.
- Add Repository is desktop-only and uses a native folder picker.
- Browser and remote clients do not expose Add Repository.
- Add Repository accepts only a Primary Worktree path.
- Add Repository rejects Linked Worktrees, bare repositories, non-Git paths, and nested paths that are not the Git top-level Primary Worktree.
- Add Repository creates a Repository Record and a Primary Worktree Record, selects the new Repository, highlights the Primary Worktree, and emits a success Operation Record.
- If the same Primary Worktree is added again, RepoBinder selects the existing Repository instead of creating a duplicate.
- Repository Settings configure Worktree Setup Script enablement, command, default args, and related setup behavior.
- Repository Settings validation runs on save.
- Worktree Setup Script configuration is stored as structured argv: command plus default args array.
- RepoBinder spawns setup commands directly, not through a shell.
- Setup may be disabled per Repository.
- If setup is enabled and invalid, Repository Settings do not save.
- Setup command validation should reject unsafe or invalid path shapes and keep repo-relative script paths inside the Primary Worktree when the command is a path.
- New Worktree creates new Branches only.
- New Worktree uses one shared Base Branch for the whole batch.
- The default Base Branch is the Branch currently checked out in the Primary Worktree.
- If the Primary Worktree is detached, New Worktree is disabled with an explanatory message.
- RepoBinder does not fetch or pull before creating new Branches.
- Dirty Primary Worktree state is a non-blocking warning.
- New Worktree accepts 1 to 5 rows.
- The first Branch name is required.
- Empty additional Branch names are generated by suffixing the first Branch name with `-2`, `-3`, and so on.
- Branch names are validated with Git branch-name validation before execution starts.
- Requested and generated Branch names must be unique within the Selected Repository.
- Branch names can repeat across unrelated Repositories.
- Validate all Branch names, Base Branch state, duplicates, and generated Worktree Paths before running any Git command.
- If validation fails for any row, abort the whole submission and show row-level validation errors.
- RepoBinder generates Worktree Paths by default and does not ask the user to type paths in the first version.
- Generated Linked Worktree Paths are adjacent to the Primary Worktree and use `<primary-worktree-folder>-<branch-slug>`.
- The Worktree Path Slug is derived from the Branch name and is not the Branch name itself.
- If a generated Worktree Path already exists on disk, the row fails validation.
- Generated Worktree Paths must not match any non-deleted Worktree Record across all Repositories after normalization.
- Custom worktree parent directories are out of scope.
- RepoBinder owns Git worktree creation using Git commands.
- The Worktree Setup Script runs only after RepoBinder successfully creates the Git Linked Worktree.
- The Worktree Setup Script runs inside the new Linked Worktree.
- The Worktree Setup Script may install dependencies, copy env files, run project-specific bootstrap steps, and optionally start a Dev Server.
- The Worktree Setup Script must not create/delete Git worktrees or act as the source of truth for Branch, Worktree Path, or Repository records.
- If Git creation succeeds and setup fails, keep the Linked Worktree, register it with failed setup status, and show a warning result.
- If setup succeeds with no metadata, the Linked Worktree is still successful.
- Setup metadata JSON is optional.
- If stdout contains valid JSON matching the setup metadata schema, parse it.
- If stdout is empty or plain logs and exit code is 0, treat setup as success with no metadata.
- If stdout is non-empty but not valid JSON and exit code is 0, capture it as logs and note that no metadata was parsed.
- If metadata is present, stdout must be pure JSON. Progress logs should go to stderr.
- A v1 setup metadata schema should use status rather than older `ok` or `agentRunnable` fields.
- Allowed setup metadata statuses are `success`, `warning`, and `failed`.
- Non-zero setup script exit counts as failed even if JSON is missing or contradictory.
- Setup metadata may include warnings, Dev Server URL/port/PID, and multiple process entries with one primary process.
- Capture setup stdout, stderr, exit code, duration, parsed metadata, and warnings.
- Setup script timeout is 10 minutes.
- Captured stdout and stderr are capped at 256 KiB each.
- If setup exceeds timeout or log limits, mark setup as failed and record the failure.
- Auto Start Dev Server appends `--port <port>` after Repository default args, shared run args, and row-specific args.
- Auto Start Dev Server rejects user-provided `--port` args for that run.
- Auto Start Dev Server is disabled when setup is disabled.
- Port reservation starts at 3000 and scans upward.
- Reserve ports for the whole batch before Git creation starts.
- Setup scripts still need to tolerate races where another process takes a port before server startup.
- Support Repository default args, shared run args, and optional collapsed row-specific args.
- Effective args are Repository default args, shared run args, row-specific args, then optional `--port <port>`.
- Run setup scripts sequentially within a batch.
- Allow only one global mutating operation at a time across RepoBinder.
- Global mutating operations include Add Repository, save Repository Settings, Add Existing Worktree, create batch, and delete Linked Worktree.
- Disable other mutating actions while a global mutating operation is running.
- Disable manual refresh while a global mutating operation is running.
- Allow Open Dev and Open Terminal during mutation when their target row is not being mutated.
- After a create batch, select the first successfully created Linked Worktree.
- If no Linked Worktree succeeds, keep the previous selection and show the result.
- Create batch Operation Records include per-row validation, Git creation, setup, and Dev Server status.
- Deletion is only for Linked Worktrees in this PRD.
- Delete action belongs on the Linked Worktree row, not hidden inside Repository Settings.
- Delete uses a normal confirmation dialog.
- The delete confirmation shows whether it will remove the Worktree Path and whether it will delete the Branch.
- Branch deletion is optional.
- Branch deletion defaults on for RepoBinder-created Linked Worktrees.
- Branch deletion defaults off for manually added existing Linked Worktrees.
- Branch deletion uses safe Git delete behavior by default.
- Force-deleting unmerged Branches is out of scope.
- Worktree removal uses `git worktree remove` as the primary operation.
- If the Worktree Path is missing or already removed, run Git prune and soft-delete the Worktree Record where appropriate.
- Avoid raw filesystem deletion except as a future force-cleanup feature.
- Delete stops Tracked Processes before worktree removal.
- Delete stops process trees rooted at tracked PIDs with graceful termination first and force kill after a timeout.
- Delete prunes worktree metadata when appropriate.
- Delete soft-deletes the Worktree Record after successful or already-complete removal.
- Delete selects the Primary Worktree afterward when the deleted Worktree was selected.
- Delete Operation Records summarize process stop, worktree remove, prune, Branch delete, and soft-delete outcomes.
- The Worktree list is a dense table/list on desktop.
- Desktop Worktree rows include Branch, type, Worktree Path, setup status, Dev Server status, and actions.
- Actions include Open Dev, Open Terminal where available, Delete for Linked Worktrees, and More/details.
- The sidebar may show compact Dev Server status dots/badges.
- Detailed PID, port, and reachability state lives in the main list/details.
- Display locked and prunable Git worktree state as warnings for Tracked Worktrees.
- Do not expose lock/unlock/prune controls in this PRD, except prune as part of deletion cleanup.
- Refresh on startup, after create/delete/add-existing, on focus, and via manual refresh.
- Avoid aggressive polling for all Repositories.
- Poll process and Dev Server status lightly for the Selected Repository, such as every 10 seconds.
- PID liveness is advisory unless RepoBinder can verify process identity through start time or platform-specific identity.
- Rely on host-side port reachability for Open Dev availability when PID identity is uncertain.
- Open Dev opens the primary Dev Server URL for a Worktree.
- Open Dev may be shown when a valid local URL or valid port is known.
- PID is useful but not required for Open Dev.
- Before opening, RepoBinder verifies localhost reachability from the RepoBinder host.
- TCP connection to the URL host/port is enough for reachability.
- Only localhost, 127.0.0.1, and [::1] URLs are actionable for Open Dev in this PRD.
- Non-local URLs returned by setup scripts may be stored as metadata but do not render an Open Dev action.
- In browser or remote mode, Open Dev opens the URL in the browser client. It is acceptable if the remote browser cannot connect to a host-local Dev Server.
- Open Dev failures create warning Operation Records.
- Successful Open Dev actions do not create Operation Records.
- Open Terminal is available for every Tracked Worktree in desktop mode.
- Open Terminal is hidden in browser and remote mode.
- Open Terminal uses OS-appropriate default terminal behavior for the first version.
- Configurable terminal commands are out of scope.
- Open Terminal failures create Operation Records.
- Successful Open Terminal actions do not need Operation Records.
- Inline banners are driven by Operation Records.
- Success and info banners auto-dismiss after about 5 seconds.
- Warning and error banners auto-dismiss after about 12 seconds.
- Recent Operation Records remain available through an activity/details sheet or drawer.
- Persist recent Operation Records with a retention limit, such as the latest 100 operations.
- Operation Records include severity, summary, timestamp, relevant IDs, and operation-specific details.
- The UI should use shadcn/ui components.
- The manual shadcn component add list is:

```sh
pnpm dlx shadcn@latest add sidebar scroll-area button button-group badge alert dialog alert-dialog sheet dropdown-menu separator input textarea field label checkbox switch select table tabs tooltip collapsible empty skeleton spinner
```

- Expected shadcn usage:
  - `sidebar` for the desktop two-pane shell.
  - `scroll-area` for sidebar and long panels.
  - `button`, `button-group`, and `dropdown-menu` for actions.
  - `badge` for status and PID/port indicators.
  - `alert` for inline banners.
  - `dialog` for New Worktree and details where appropriate.
  - `alert-dialog` for delete confirmation.
  - `sheet` for settings, activity, and mobile sidebar.
  - `input`, `textarea`, `field`, `label`, `checkbox`, `switch`, and `select` for forms.
  - `table` for desktop Worktree lists.
  - `tabs` where settings/details need compact sections.
  - `tooltip` for icon-only actions.
  - `collapsible` for per-row args and log details.
  - `empty`, `skeleton`, and `spinner` for empty/loading states.
- Use Lucide icons for icon buttons and status/action affordances.
- The UI must be responsive/mobile-capable.
- On mobile, collapse the sidebar into a sheet opened by a menu button.
- On mobile, render Worktrees as stacked dense rows rather than a wide table.
- On mobile, preserve create, delete, Open Dev, and details without requiring horizontal scrolling.
- Browser/remote mode can create and delete RepoBinder-managed Linked Worktrees, including on mobile.
- Remote mode remains trusted-network-only in this PRD.
- Authentication is out of scope.
- The UI should show a persistent warning when remote mode is enabled.
- Accessibility requirements: keyboard-accessible sidebar, list/table, row actions, settings, dialogs, and sheets; visible focus states; ARIA labels for icon-only actions; semantic structure for dense lists/tables; dark UI contrast suitable for normal use.
- Status may be conveyed by color alone.
- Legacy cleanup is required before this PRD is considered done: replace old workspace/Codex script-contract language with the new Worktree Setup Script model, remove Codex-oriented concepts such as `agentRunnable`, remove Deskbinder references, and remove browser localStorage Repository persistence.

## Testing Decisions

- No automated tests are required by this PRD.
- Implementation should still include a manual QA checklist because the feature mutates local Git state and filesystem-backed records.
- Manual QA should exercise externally visible behavior rather than implementation internals.
- Manual QA should use disposable Git repositories and disposable Linked Worktrees.

Manual QA checklist:

1. Add a valid Primary Worktree in desktop mode and confirm it appears as the selected Repository with a Primary Worktree row.
2. Attempt to add a non-Git path and confirm an inline error appears.
3. Attempt to add a Linked Worktree through Add Repository and confirm it is rejected.
4. Add the same Primary Worktree twice and confirm the existing Repository is selected rather than duplicated.
5. Confirm Add Repository is hidden in browser/remote mode.
6. Save valid Repository Settings with setup enabled.
7. Attempt to save invalid setup configuration and confirm it is rejected.
8. Disable setup and confirm New Worktree still creates Git Linked Worktrees.
9. Create one Linked Worktree from a Primary Worktree with a checked-out Branch.
10. Attempt New Worktree from a detached Primary Worktree and confirm the action is disabled or blocked with explanation.
11. Create a 2-5 row batch with empty additional Branch names and confirm suffix generation.
12. Enter a duplicate Branch name and confirm validation aborts the whole batch before Git commands run.
13. Create a dirty Primary Worktree and confirm New Worktree shows a non-blocking warning.
14. Create with Auto Start Dev Server enabled and confirm `--port` is passed to setup.
15. Confirm Auto Start Dev Server is disabled when setup is disabled.
16. Confirm user-provided `--port` args are rejected when Auto Start Dev Server is enabled.
17. Run a setup script that exits 0 with no JSON and confirm setup success with no metadata.
18. Run a setup script that exits 0 with valid metadata JSON and confirm Dev Server metadata is stored.
19. Run a setup script that exits 0 with warnings and confirm setup warning status.
20. Run a setup script that exits non-zero and confirm the Linked Worktree remains registered with failed setup status.
21. Confirm partial runtime failures in a batch produce an Operation Record with per-row details.
22. Confirm only one global mutating operation can run at a time.
23. Confirm manual refresh is disabled during mutation.
24. Confirm the first successful Linked Worktree is selected after a create batch.
25. Confirm Open Dev appears for valid localhost Dev Server metadata.
26. Confirm Open Dev verifies host-side TCP reachability before opening.
27. Confirm Open Dev failure creates a warning Operation Record.
28. Confirm successful Open Dev does not create an Operation Record.
29. Confirm Open Dev opens in the browser client in browser/remote mode.
30. Confirm Open Terminal appears in desktop mode for Primary and Linked Worktrees.
31. Confirm Open Terminal is hidden in browser/remote mode.
32. Confirm Open Terminal failure creates an Operation Record.
33. Delete a RepoBinder-created Linked Worktree with Branch deletion enabled and confirm safe branch deletion is attempted.
34. Delete a manually added existing Linked Worktree and confirm Branch deletion defaults off.
35. Confirm delete uses a normal confirmation dialog.
36. Confirm Primary Worktree delete is disabled.
37. Confirm deletion stops tracked process trees before removing the Worktree.
38. Confirm deletion selects the Primary Worktree afterward when deleting the selected Linked Worktree.
39. Confirm missing stored Worktree Paths show unavailable warnings rather than disappearing.
40. Confirm locked/prunable Git worktree state is visible as warnings.
41. Confirm success/info banners auto-dismiss around 5 seconds.
42. Confirm warning/error banners auto-dismiss around 12 seconds.
43. Confirm recent Operation Records remain visible in the activity/details view.
44. Restart the app and confirm persisted Repository, Worktree, settings, process metadata, and recent Operation Records load from the backend store.
45. Confirm old browser `localStorage` repository persistence is no longer used.
46. Confirm responsive desktop, tablet, and phone-width layouts remain usable.
47. Confirm mobile sidebar opens in a sheet.
48. Confirm mobile create/delete flows fit the viewport.
49. Confirm keyboard navigation reaches sidebar items, row actions, dialogs, settings, and activity details.
50. Confirm legacy Deskbinder, workspace, and Codex language no longer appears in the product surface or updated docs.

## Out of Scope

- Codex integration of any kind.
- Deskbinder branding or Deskbinder workspace concepts.
- Authentication and authorization for remote mode.
- Treating remote mode as safe outside trusted networks.
- Add Repository in browser/remote mode.
- Repository removal.
- Physical deletion of the Primary Worktree.
- Automatic discovery of untracked Git worktrees.
- Fetching or pulling before creating a Linked Worktree.
- Creating a Linked Worktree for an existing Branch.
- Per-row Base Branch selection.
- Custom worktree parent directories.
- Branch rename.
- Worktree Path move/rename.
- Force-deleting unmerged Branches.
- Raw filesystem removal as the normal delete path.
- Lock/unlock/prune management UI beyond prune during deletion cleanup.
- Configurable terminal command templates.
- Remote Dev Server forwarding or URL rewriting.
- Opening non-local Dev Server URLs.
- Full audit log product.
- Automated test requirement.

## Further Notes

This PRD intentionally replaces the old Deskbinder/Codex-oriented model. RepoBinder owns Git worktree creation and deletion. Repository-owned scripts are optional post-creation setup scripts, not workspace creators and not Codex launchers.

Remote mode may mutate RepoBinder-managed Linked Worktrees because the user requested browser/remote create and delete. This does not change ADR-0001's security stance: remote mode is trusted-network-only until a future authentication PRD exists.

Implementation should be split into practical phases:

1. Local JSON store, schema versioning, Operation Records, and API resource model.
2. Repository add, Repository Settings, sidebar, selection, and responsive shell.
3. New Worktree validation, path generation, Git creation, and batch results.
4. Worktree Setup Script execution, metadata parsing, Dev Server tracking, and process status.
5. Linked Worktree deletion, process cleanup, safe Branch deletion, and soft-delete behavior.
6. Activity/details view, auto-dismiss banners, refresh behavior, and remote-mode warnings.
7. Mobile layout polish, accessibility pass, and legacy cleanup.
