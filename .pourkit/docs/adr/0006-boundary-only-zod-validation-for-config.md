# ADR-0006: Boundary-Only Zod Validation for Config

## Status

Accepted

## Context

Pourkit loads user-provided configuration files (`pourkit.config.ts`, `pourkit.config.mjs`, `pourkit.json`) from disk at runtime. These files represent untrusted external input that must be validated before being used by trusted in-process code.

Before this decision, config parsing used hand-written type guards and validation logic in `pourkit/shared/config.ts`. This approach required manual maintenance of validation rules, type assertions, and error messages, and did not provide structured unknown-key rejection or a clear boundary between parsed input and validated domain types.

The team evaluated whether to adopt a schema validation library and, if so, what scope and constraints should apply.

## Decision

Zod SHALL be adopted for runtime validation of config file content only, within the following boundaries and constraints:

### In Scope

1. **Config-only validation**: Zod schemas SHALL validate config file content after it has been loaded and parsed by `jiti`. No other runtime boundaries SHALL use Zod in this slice.
2. **Colocated schemas**: Zod schemas SHALL live in `pourkit/shared/config.ts` alongside the domain types they validate, not in a separate schema directory.
3. **Strict unknown-key rejection**: Config object schemas SHALL use `.strict()` or equivalent to reject unknown keys at the config root and within validated sub-objects, preventing silent acceptance of typos or removed fields.
4. **Removed deprecated fields**: Fields that were previously rejected by hand-written guards (e.g., `implementor`, `verificationCommands` at the target level) SHALL continue to be rejected — now via Zod unknown-key rejection rather than explicit throw statements.
5. **Hand-written domain types remain**: TypeScript `type` and `interface` definitions for config domain types SHALL remain hand-written. Zod's `z.infer` SHALL NOT replace them — schemas and types SHALL be maintained separately and kept in sync by convention.

### Out of Scope (Non-Goals)

The following boundaries and capabilities SHALL NOT be validated using Zod in this slice:

1. **Worktree Run State** (`.pourkit/state.json`): Runner-owned metadata is not user-provided input and does not require schema validation.
2. **CLI JSON output**: Output from `gh` CLI commands is consumed as parsed JSON and checked via type predicates specific to each API call site.
3. **Managed manifests** (`opencode.json`, `package.json`): These are managed by the runner or package manager, not user-provided config for Pourkit.
4. **JSON Schema generation**: Zod schemas SHALL NOT be used to generate JSON Schema documents.
5. **Base64 or other encoding validation**: Zod SHALL NOT be used to validate serialization formats.

### Version Constraint

Zod v3.x (`^3.24.5`) SHALL be used. Zod v4 is not yet stable and would introduce breaking changes.

## Consequences

- Config validation logic becomes declarative and composable via Zod schemas instead of hand-written guards.
- Unknown keys in user config are automatically rejected, preventing silent misconfiguration.
- Deprecated field rejection moves from explicit throw statements to Zod's built-in unknown-key handling, reducing manual validation code.
- Hand-written domain types remain the source of truth for TypeScript consumers; schemas must be manually kept in sync (accepted cost).
- No runtime dependency on Zod exists outside the config validation boundary.
- Future slices may expand Zod validation to new boundaries, but each expansion requires a separate ADR.

## Alternatives Considered

- **Hand-written guards (status quo)**: Rejected because maintaining manual validation logic is error-prone, verbose, and does not provide structured unknown-key rejection.
- **JSON Schema with ajv**: Rejected because it would require generating and maintaining JSON Schema documents separate from TypeScript types, adding complexity without clear benefit over Zod's colocated schema approach.
- **Zod for all runtime boundaries**: Rejected as over-engineering for this slice. Worktree run state, CLI JSON output, and managed manifests have different trust characteristics and validation requirements.
- **z.infer for domain types**: Rejected because generated types obscure the hand-written type contracts and make it harder to reason about the domain model independently of the validation library.
