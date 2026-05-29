# RepoBinder

RepoBinder helps a developer manage the Git worktrees attached to a repository. It uses Git's worktree model rather than treating each checkout as an independent clone.

## Language

**RepoBinder**:
The application that manages Git worktrees attached to local repositories.
_Avoid_: Deskbinder

**Repository**:
A Git repository whose worktrees are managed by RepoBinder. A Repository can have one Primary Worktree and zero or more Linked Worktrees.
_Avoid_: Project, repo folder

**Repository Record**:
RepoBinder's local record for a Repository on one machine. A Repository Record has a local identity and points to one Primary Worktree.
_Avoid_: Project record

**Repository Settings**:
Local configuration attached to a Repository Record, including whether a Worktree Setup Script should run for newly created Linked Worktrees.
_Avoid_: Project settings

**Worktree**:
A filesystem checkout attached to a Repository. A Worktree has exactly one Worktree Path and may have a Branch checked out.
_Avoid_: Workspace, clone, copy

**Worktree Record**:
RepoBinder's local record for a Worktree on one machine. A Worktree Record belongs to one Repository Record and is either primary or linked.
_Avoid_: Workspace record

**Tracked Worktree**:
A Worktree that has a Worktree Record in RepoBinder. RepoBinder shows Tracked Worktrees and does not automatically add untracked Git worktrees from disk.
_Avoid_: Discovered worktree

**Soft-Deleted Record**:
A Repository Record or Worktree Record hidden from normal lists but retained in RepoBinder's local data store with a deletion timestamp.
_Avoid_: Archived when referring to deletion state

**Primary Worktree**:
The original Worktree for a Repository. RepoBinder displays it as the parent Worktree for that Repository but does not remove it.
_Avoid_: Main worktree, root checkout, primary branch

**Linked Worktree**:
An additional Worktree created with `git worktree add`. RepoBinder may create or remove Linked Worktrees.
_Avoid_: Secondary checkout, extra clone

**Selected Repository**:
The Repository whose Worktrees are shown in the main dashboard.
_Avoid_: Active workspace

**Selected Worktree**:
The Worktree highlighted within the Selected Repository. Selecting a Worktree does not change which Repository the dashboard is showing.
_Avoid_: Active workspace

**Worktree Path**:
The filesystem location of a Worktree.
_Avoid_: Folder, directory

**Worktree Path Slug**:
A filesystem-safe name derived from a Branch name for generating a Linked Worktree's Worktree Path. It is not the Branch name itself.
_Avoid_: Workspace name

**Branch**:
A Git branch checked out in a Worktree, or created when a new Linked Worktree is created.
_Avoid_: Ref when the user is choosing a named branch

**Base Branch**:
The Branch used as the starting point when RepoBinder creates a new Linked Worktree. By default, it is the Branch currently checked out in the Primary Worktree.
_Avoid_: Primary branch, source branch

**Worktree Setup Script**:
A repository-owned script that RepoBinder may run inside a newly created Linked Worktree after the Git worktree exists.
_Avoid_: Workspace script, creation script

**Dev Server**:
A local development process associated with a Worktree. RepoBinder may track its process id, port, and URL when a Worktree Setup Script reports them.
_Avoid_: Dev environment when referring to the running process

**Tailscale Routing**:
A Repository Setting that asks Auto Start Dev Server to make the Dev Server reachable from devices already connected to the same tailnet as the RepoBinder machine. RepoBinder does not configure Tailscale itself.
_Avoid_: Remote mode when referring only to Dev Server reachability

**Tracked Process**:
A local process id reported by a Worktree Setup Script and stored by RepoBinder for status checks and cleanup. A Worktree may have multiple Tracked Processes, with at most one primary Dev Server.
_Avoid_: Process when referring to RepoBinder-managed cleanup state

**Operation Record**:
A persisted RepoBinder record describing a recent user-triggered operation and its result. Operation Records drive inline banners and the activity details view.
_Avoid_: Toast history

## Example Dialogue

Dev: "Which Repository should RepoBinder load?"

Domain expert: "Load the Repository at `/src/app`. Its Primary Worktree is there."

Dev: "Should I create a clone for `feature/search`?"

Domain expert: "No. Create a Linked Worktree at `/src/app-search` with the Branch `feature/search`."

Dev: "Should the setup script create the Git worktree?"

Domain expert: "No. RepoBinder creates the Linked Worktree from the Base Branch, then runs the Worktree Setup Script inside it."
