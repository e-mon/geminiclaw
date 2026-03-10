---
name: github
description: GitHub operations via gh CLI (PRs, Issues, CI checks, API queries). Not for local git operations.
enabled: true
---

# GitHub Skill

Operate on GitHub repository PRs, Issues, and CI using the `gh` CLI.
Execute via `run_shell_command`.

## When to Use

✅ **Use for:**
- Checking PR status, reviews, and merge readiness
- Checking CI/workflow run status and logs
- Creating, closing, and commenting on Issues
- Creating and merging PRs
- Querying repository information via the GitHub API

❌ **Do not use for:**
- Local git operations (commit, push, pull, branch) → use `git` directly
- Cloning repositories → use `git clone`
- Actual code changes or reviews → read files directly

## Setup (first time only)

```bash
gh auth login
gh auth status
```

## Pull Request

```bash
# List
gh pr list --repo owner/repo

# Check CI status
gh pr checks 55 --repo owner/repo

# View details
gh pr view 55 --repo owner/repo

# Create
gh pr create --title "feat: add feature" --body "Description..."

# Merge
gh pr merge 55 --squash --repo owner/repo
```

## Issue

```bash
# List
gh issue list --repo owner/repo --state open

# Create
gh issue create --title "Bug: description of the issue" --body "Details..."

# Close
gh issue close 42 --repo owner/repo
```

## CI / Workflows

```bash
# List recent runs
gh run list --repo owner/repo --limit 10

# View a specific run
gh run view <run-id> --repo owner/repo

# Show logs for failed steps only
gh run view <run-id> --repo owner/repo --log-failed

# Rerun failed jobs
gh run rerun <run-id> --failed --repo owner/repo
```

## API Queries

```bash
# Get PR information
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'

# List labels
gh api repos/owner/repo/labels --jq '.[].name'

# Repository statistics
gh api repos/owner/repo --jq '{stars: .stargazers_count, forks: .forks_count}'
```

## JSON Output

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
gh pr list --json number,title,state,mergeable --jq '.[] | select(.mergeable == "MERGEABLE")'
```

## Tips

- Always specify `--repo owner/repo` when outside a git directory
- URLs can be used directly: `gh pr view https://github.com/owner/repo/pull/55`
- Use `gh api --cache 1h` to cache repeated queries
