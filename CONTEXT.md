# RepoBinder

RepoBinder helps a developer manage the Git worktrees attached to a repository. It uses Git's worktree model rather than treating each checkout as an independent clone.

## Language

**Repository**:
A Git repository whose worktrees are managed by RepoBinder. A Repository can have one Primary Worktree and zero or more Linked Worktrees.
_Avoid_: Project, repo folder

**Worktree**:
A filesystem checkout attached to a Repository. A Worktree has exactly one Worktree Path and may have a Branch checked out.
_Avoid_: Workspace, clone, copy

**Primary Worktree**:
The original Worktree for a Repository. RepoBinder displays it for context but does not remove it.
_Avoid_: Main worktree, root checkout

**Linked Worktree**:
An additional Worktree created with `git worktree add`. RepoBinder may create or remove Linked Worktrees.
_Avoid_: Secondary checkout, extra clone

**Worktree Path**:
The filesystem location of a Worktree.
_Avoid_: Folder, directory

**Branch**:
A Git branch checked out in a Worktree, or created when a new Linked Worktree is created.
_Avoid_: Ref when the user is choosing a named branch

## Example Dialogue

Dev: "Which Repository should RepoBinder load?"

Domain expert: "Load the Repository at `/src/app`. Its Primary Worktree is there."

Dev: "Should I create a clone for `feature/search`?"

Domain expert: "No. Create a Linked Worktree at `/src/app-search` with the Branch `feature/search`."
