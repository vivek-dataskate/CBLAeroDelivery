---
name: git-pr-flow
description: 'Create a branch, commit changes, push to origin, open a pull request to main, merge it, and delete the branch. Use when the user asks to commit, publish, push, open a PR, or merge work to GitHub.'
argument-hint: 'Describe the change and preferred commit title'
user-invocable: true
---

# Git PR Flow

## When to Use
- The user asks to commit changes.
- The user wants work published to GitHub.
- The user asks for a pull request or merge to `main`.

## Procedure
1. Check that the working tree is in a valid state and summarize pending changes.
2. Sync local `main` with `origin/main` if needed.
3. Create a short-lived branch named for the change.
4. Commit the intended changes on that branch.
5. Push the branch to `origin`.
6. Open a pull request targeting `main`.
7. Merge the pull request once ready.
8. Delete the branch remotely and locally after merge.
9. Report the final PR URL, merge commit, and cleanup result.

## Notes
- If the user explicitly wants a direct push to `main`, do not use this workflow.
- If branch protection or required checks block merge, stop after opening the pull request and report the blocker.