#!/usr/bin/env bash
set -euo pipefail

target="${npm_config_target:-}"
if [[ -z "$target" ]]; then
  printf '%s\n' "Missing required --target for pourkit:e2e:test-live" >&2
  exit 1
fi

args=("$@")
if [[ ${#args[@]} -gt 0 && "${args[0]}" == "$target" ]]; then
  args=("${args[@]:1}")
fi

POURKIT_RUN_LIVE_E2E=true POURKIT_LIVE_E2E_TARGET="$target" \
  node node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers 1 "${args[@]}"
