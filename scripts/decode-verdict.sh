#!/usr/bin/env bash
# Decode the abidiff exit-code bitmap into a verdict and decide whether the
# job should fail given the configured fail-on policy.

set -euo pipefail

EXIT_CODE="${ABIDIFF_EXIT:-0}"
FAIL_ON="${FAIL_ON:-incompatible}"

# libabigail exit-code bitmap (see abidiff(1)).
ABIDIFF_ERROR=1
ABIDIFF_USAGE_ERROR=2
ABIDIFF_ABI_CHANGE=4
ABIDIFF_ABI_INCOMPATIBLE_CHANGE=8

verdict=""
if (( EXIT_CODE & (ABIDIFF_ERROR | ABIDIFF_USAGE_ERROR) )); then
  verdict="error"
elif (( EXIT_CODE & ABIDIFF_ABI_INCOMPATIBLE_CHANGE )); then
  verdict="incompatible"
elif (( EXIT_CODE & ABIDIFF_ABI_CHANGE )); then
  verdict="additions-only"
elif (( EXIT_CODE == 0 )); then
  verdict="compatible"
else
  verdict="error"
fi

case "$verdict" in
  compatible)     summary="No ABI changes detected." ;;
  additions-only) summary="ABI changed but only with additions (backward-compatible)." ;;
  incompatible)   summary="ABI-incompatible changes detected." ;;
  error)          summary="abidiff reported an error (exit=${EXIT_CODE}); ABI verdict is undetermined." ;;
esac

# An undetermined run (tool error) always fails: callers cannot trust the
# verdict regardless of fail-on.
if [[ "$verdict" == "error" ]]; then
  should_fail="true"
else
  case "$FAIL_ON" in
    none)
      should_fail="false"
      ;;
    addition|change)
      if [[ "$verdict" == "compatible" ]]; then
        should_fail="false"
      else
        should_fail="true"
      fi
      ;;
    incompatible)
      if [[ "$verdict" == "incompatible" ]]; then
        should_fail="true"
      else
        should_fail="false"
      fi
      ;;
    *)
      echo "::error::Unknown fail-on value: $FAIL_ON (expected: none | addition | change | incompatible)"
      exit 2
      ;;
  esac
fi

emit_output() {
  local key="$1" value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "${key}=${value}" >> "$GITHUB_OUTPUT"
  fi
  echo "${key}=${value}"
}

emit_output "verdict"     "$verdict"
emit_output "summary"     "$summary"
emit_output "should-fail" "$should_fail"
