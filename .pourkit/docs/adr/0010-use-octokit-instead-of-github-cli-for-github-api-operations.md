# ADR 0010: Use Octokit Instead of GitHub CLI for GitHub API Operations

## Status

Accepted

## Context

Pourkit's GitHub providers (`GitHubIssueProvider`, `GitHubPRProvider`) need to query issues, pull requests, comments, and labels from the GitHub API. Early implementations used the GitHub CLI (`gh`) via shell commands and JSON parsing, but this approach had several drawbacks:

- Shelling out to `gh` introduced coupling to the CLI's installed version, JSON output format, and exit codes.
- Error handling required parsing `stderr` text rather than typed exception objects.
- GraphQL queries required awkward string escaping and manual result traversal.
- Adding or modifying API calls required duplicating shell-out patterns across providers.

At the same time, the existing `git` operations (branch checkout, rebase, log) are local repository operations that do not cross the GitHub API boundary and were not affected by this decision.

## Decision

Use Octokit (the official GitHub SDK) for all GitHub API operations in the Pourkit codebase.

- Providers receive an Octokit client instance at construction time instead of executing `gh` commands.
- GraphQL queries use Octokit's typed `graphql` method instead of shell string interpolation.
- There is no compatibility fallback to the GitHub CLI for API operations — if Octokit is unavailable or misconfigured, the operation fails fast rather than degrading to `gh`.
- Local `git` operations remain `git` shell-out commands and are not migrated to Octokit.

## Rejected Alternatives

- **GitHub CLI (`gh`) as the sole interface**: Rejected because error handling and JSON output parsing were fragile, and adding new API calls required repetitive shell-out boilerplate.
- **Dual support (Octokit + `gh` fallback)**: Rejected because maintaining two code paths for every API operation doubles the maintenance surface and creates subtle divergence in error behavior. The contract decision explicitly excludes a fallback.
- **HTTP client + manual REST calls**: Rejected because Octokit provides typed request/response handling, pagination, and authentication out of the box.

## Consequences

- API calls use typed request and response objects, improving testability and maintainability.
- Octokit is an explicit dependency of the Pourkit runtime; providers cannot function without it.
- Provider names (`GitHubIssueProvider`, `GitHubPRProvider`) are kept as-is — Octokit is an implementation detail, not a naming concern.
- The `gh` CLI remains available in the environment for setup and debugging but is no longer a runtime dependency for API operations.
- Local `git` operations remain unchanged and continue to use shell-out.
