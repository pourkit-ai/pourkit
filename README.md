# pourkit

AI-driven issue-to-PR workflow for GitHub repositories.

## Workspace

- `pourkit`: CLI and agent orchestration (`@pourkit/cli`)
- `common/logger`: structured logging (`@pourkit/logger`)

## Getting Started

1. Install dependencies with `npm install`
2. Run the CLI with `pourkit`
3. Run tests with `npm test` (human) or `npm run test:agent` (agent/CI)
4. Run typecheck with `npm run typecheck`
5. Run build with `npm run build`

## GitHub Authentication

Pourkit uses environment variable tokens for GitHub API access. Token precedence:

1. `POURKIT_GITHUB_TOKEN` — Pourkit-specific token (highest priority)
2. `GH_TOKEN` — GitHub token
3. `GITHUB_TOKEN` — GitHub Actions default token

Fine-grained personal access tokens (PATs) are preferred. Classic PATs and GitHub Actions `GITHUB_TOKEN` (with sufficient repository permissions) are also supported.

Set the desired token in your environment before running Pourkit. No separate GitHub command-line authentication is required for Pourkit runtime.

## Pourkit CLI

- `pourkit issue <number> --target <name> --config <path>` is the canonical entry point for the single-issue workflow.
- `pourkit pr create --config <path> --target <name> --title <title>` is the canonical PR creation workflow for humans and agents.
- `pourkit pr merge <number>` is the canonical PR merge workflow. It waits for checks, merges through Pourkit's Octokit-backed provider, and waits for the target branch to become green.
- `npm run pourkit:e2e` exercises the live end-to-end coverage for that workflow.

