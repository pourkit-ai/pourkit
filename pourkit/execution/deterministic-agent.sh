#!/bin/bash
# Deterministic agent script for E2E testing.

set -euo pipefail

FIXTURE_FILE="pourkit/e2e/fixtures/e2e-fixture.txt"
STAGE="${POURKIT_STAGE:-builder}"
ARTIFACT_PATH="${POURKIT_ARTIFACT_PATH:-}"
REVIEW_ITERATION="${POURKIT_REVIEW_ITERATION:-}"

log() {
  printf '[deterministic-agent] %s\n' "$1"
}

ensure_parent_dir() {
  mkdir -p "$(dirname "$1")"
}

ensure_fixture_exists() {
  if [ ! -f "$FIXTURE_FILE" ]; then
    log "Creating fixture file: $FIXTURE_FILE"
    mkdir -p "$(dirname "$FIXTURE_FILE")"
    cat > "$FIXTURE_FILE" <<EOF
This fixture file was created by the deterministic agent during E2E testing.
Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF
  fi
}

create_commit() {
  local commit_message="$1"
  git add "$FIXTURE_FILE"
  git commit -m "$commit_message"
}

write_reviewer_artifact() {
  if [ -z "$ARTIFACT_PATH" ]; then
    log "ERROR: reviewer stage missing POURKIT_ARTIFACT_PATH"
    exit 1
  fi

  ensure_parent_dir "$ARTIFACT_PATH"

  if [ "$REVIEW_ITERATION" = "1" ]; then
    cat > "$ARTIFACT_PATH" <<'EOF'
## Findings

| Severity | File/Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| low | `pourkit/e2e/fixtures/e2e-fixture.txt` | Builder left only the initial deterministic marker, so the refactor flow has not been exercised yet. | Append a deterministic refactor marker to prove the review-refactor-review loop completed. |

## Summary

Deterministic review requires one safe follow-up edit so the refactor stage is exercised end-to-end.

NEEDS_REFACTOR

## Recommendations

- Append a deterministic refactor marker to `pourkit/e2e/fixtures/e2e-fixture.txt`.
EOF
    return
  fi

  cat > "$ARTIFACT_PATH" <<'EOF'
## Findings

| Severity | File/Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| none | n/a | No findings. | n/a |

## Summary

Deterministic builder and refactor artifacts are present and the worktree is ready to ship.

PASS

## Recommendations

- None.
EOF
}

write_pr_description_artifact() {
  if [ -z "$ARTIFACT_PATH" ]; then
    log "ERROR: pr-description stage missing POURKIT_ARTIFACT_PATH"
    exit 1
  fi

  ensure_parent_dir "$ARTIFACT_PATH"
  cat > "$ARTIFACT_PATH" <<'EOF'
## PR Title

Deterministic E2E pipeline coverage

## PR Body

Exercises the deterministic builder, reviewer, refactor, and PR description stages end-to-end for the E2E issue flow.
EOF
}

run_builder() {
  ensure_fixture_exists
  log "Modifying fixture file for builder stage: $FIXTURE_FILE"
  cat >> "$FIXTURE_FILE" <<EOF

Modified by deterministic builder during E2E test run.
Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

  create_commit "test(e2e): modify fixture file for deterministic E2E run

- Updates e2e-fixture.txt with deterministic builder marker
- This commit is created by the deterministic agent provider
- No LLM tokens were spent in this operation"
}

run_refactor() {
  ensure_fixture_exists
  log "Appending deterministic refactor marker: $FIXTURE_FILE"
  cat >> "$FIXTURE_FILE" <<EOF

Refactor marker added by deterministic refactor stage.
Iteration: ${REVIEW_ITERATION:-1}
Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

  create_commit "test(e2e): exercise deterministic refactor stage

- Appends a deterministic refactor marker to the e2e fixture
- Proves the review-refactor-review loop completed end-to-end
- No LLM tokens were spent in this operation"
}

log "Starting deterministic agent simulation for stage: $STAGE"

case "$STAGE" in
  builder)
    run_builder
    ;;
  reviewer)
    write_reviewer_artifact
    ;;
  refactor)
    run_refactor
    ;;
  pr-description)
    write_pr_description_artifact
    ;;
  *)
    log "ERROR: unsupported deterministic stage: $STAGE"
    exit 1
    ;;
esac

log "Emitting completion signal..."
echo "<promise>COMPLETE</promise>"
