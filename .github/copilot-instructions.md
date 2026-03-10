# Project Guidelines

## Git Workflow
- When the user asks to commit or publish changes, prefer a PR workflow instead of committing directly on `main`.
- Start from an up-to-date `main`, create a short-lived branch, make the commit on that branch, push it to `origin`, open a pull request into `main`, merge it, and then delete the branch locally and remotely.
- If the user explicitly asks for a direct push to `main`, follow that request instead of the PR workflow.
- After publishing, report the branch name, pull request URL, and merge result.

## Remote
- Treat `origin` as the primary remote for publishing work.
