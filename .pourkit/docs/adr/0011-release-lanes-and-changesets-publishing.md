# ADR-0011: Release Lanes and Changesets Publishing

## Status

Accepted

## Context

Pourkit is becoming a public binary CLI package, so publishing must be repeatable, automated, and safe for both dogfooding and stable users. The release workflow also needs to match Pourkit's own branch and Target model so agents target the correct lane without humans remembering local publish commands.

## Decision

Pourkit uses two protected Release Lanes: `next` for Development Releases and `main` for Stable Releases. Every successful merge to `next` publishes a unique Changesets snapshot of `@pourkit/cli` to npm under the `next` dist-tag, without GitHub releases or permanent tags. Stable releases publish only from `main` after Changesets opens a Version Packages PR and that PR is merged; stable publishing uses the `latest` dist-tag and creates the durable release metadata.

Only `@pourkit/cli` is public; the `pourkit` binary is the installed executable, and `@pourkit/logger` remains private and bundled into the CLI. Publishing is performed by GitHub Actions from the repo root with npm workspaces, `NPM_TOKEN`, `--access public`, and provenance. User-facing changes require a Changeset before release; internal-only PRs targeting `next` or `main` use an explicit `no-changeset-needed` label.

## Consequences

- Normal feature PRs now target the `dev` Integration Branch described in ADR-0012; `next` receives promotion PRs for Development Releases.
- Release publishing is never a local/manual npm command sequence.
- `next` snapshots are intentionally noisy in npm but quiet in GitHub release history.
- The stable changelog records stable releases only, not every Development Release snapshot.
