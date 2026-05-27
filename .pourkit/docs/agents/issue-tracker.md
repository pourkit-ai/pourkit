# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. This doc describes how agents operate the repository issue tracker — it is not a Pourkit runtime prerequisite. Use the GitHub API (via Octokit in the Pourkit runtime) for all operations below.

## Conventions

- **PRD titles**: `PRD-00N: <short title>`
- **Child issue titles**: `PRD-00N / I-0N: <short slice title>`
- **Create an issue**: Use the GitHub API to create issues with title and body. Use a heredoc for multi-line bodies.
- **Read an issue**: Fetch the issue via the GitHub API, retrieving comments and labels.
- **List issues**: Query open issues via the GitHub API with appropriate filters for number, title, body, labels, and comments.
- **Comment on an issue**: Add a comment via the GitHub API.
- **Apply / remove labels**: Update issue labels via the GitHub API.
- **Close**: Close an issue via the GitHub API with an optional closing comment.

Infer the repo from `git remote -v` when available. If this clone has no remote yet, configure one before using GitHub-backed issue skills.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Fetch the issue with its comments via the GitHub API.

## Stacked Issues

- Child issues should include their parent PRD under `## Parent`.
- The child-issue title convention `PRD-00N / I-0N: ...` is the fallback when the body is missing parent metadata.
- Builder runs now build stack-aware context from the parent, closed siblings, and current contract-defining files.
- Before implementation starts, the workflow validates issue assumptions against the current base-branch reality and should stop early on obvious mismatches.
- `queue-run --prd PRD-00N` filters candidate selection to child issues under that PRD. This flag does not change issue-run context behavior.
