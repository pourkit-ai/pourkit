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

## Release Lanes

Pourkit uses two release lanes:

- **`next`** — Development Releases. Every push to `next` runs full verification, package smoke checks, and publishes a unique Changesets snapshot to npm under the `next` dist-tag. No GitHub release or permanent git tag is created.

- **`main`** — Stable Releases. Every push to `main` runs full verification, package smoke checks, and uses Changesets to open or update a Version Packages PR. Merging that PR publishes `@pourkit/cli@latest` with durable release metadata.

### Changeset requirement

User-facing pull requests targeting `next` or `main` must include a Changeset file (`.changeset/*.md`). PRs with only internal changes (refactors, CI, docs, tests) may bypass this requirement with the `no-changeset-needed` label.

Run `npx changeset` in your working directory to create a Changeset.

> Do not run `npm run changeset:publish` or `npx changeset publish` from a developer machine. Publishing is handled automatically by CI workflows on the `next` and `main` branches.

## Pourkit CLI

- `pourkit issue <number> --target <name> --config <path>` is the canonical entry point for the single-issue workflow.
- `pourkit pr create --config <path> --target <name> --title <title>` is the canonical PR creation workflow for humans and agents.
- `pourkit pr merge <number>` is the canonical PR merge workflow. It waits for checks, merges through Pourkit's Octokit-backed provider, and waits for the target branch to become green.
- `npm run pourkit:e2e` exercises the live end-to-end coverage for that workflow.

