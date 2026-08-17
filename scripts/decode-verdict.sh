#!/usr/bin/env bash
# Decode the abidiff result into a verdict and decide whether the job should
# fail given the configured fail-on policy.
#
# The exit-code bitmap alone cannot fully classify a change: per abidiff(1),
# ABIDIFF_ABI_CHANGE (bit 4) only means "the ABIs are different" — it is set
# for harmless additions AND for modified declarations that libabigail deems
# "possibly incompatible, needs human review" without setting bit 8 (e.g. a
# parameter or return type change on a symbol whose name is unchanged).
# ABIDIFF_ABI_INCOMPATIBLE_CHANGE (bit 8) is set only when libabigail can
# prove incompatibility (removed symbols, vtable changes, ...). So when only
# bit 4 is set, the report's "changes summary" lines are parsed to tell
# additions apart from removals/modifications.

set -euo pipefail

EXIT_CODE="${ABIDIFF_EXIT:-0}"
FAIL_ON="${FAIL_ON:-incompatible}"
REPORT_PATH="${REPORT_PATH:-}"

# libabigail exit-code bitmap (see abidiff(1)).
ABIDIFF_ERROR=1
ABIDIFF_USAGE_ERROR=2
ABIDIFF_ABI_CHANGE=4
ABIDIFF_ABI_INCOMPATIBLE_CHANGE=8

# Sum the Removed / Changed / Added counters across every "changes summary"
# line of the abidiff report, e.g.:
#   Functions changes summary: 0 Removed, 1 Changed, 0 Added function
#   Variables changes summary: 0 Removed, 0 Changed, 0 Added variable
# Symbol-table-only diffs (no DWARF) emit "Function symbols changes summary"
# / "Variable symbols changes summary" lines instead; matched as well. The
# leading counter excludes suppressed changes ("(N filtered out)"), matching
# abidiff's own exit-code semantics.
removed=0 changed=0 added=0
if [[ -n "$REPORT_PATH" && -f "$REPORT_PATH" ]]; then
  while IFS= read -r line; do
    if [[ "$line" =~ ([0-9]+)[[:space:]]Removed ]]; then removed=$(( removed + BASH_REMATCH[1] )); fi
    if [[ "$line" =~ ([0-9]+)[[:space:]]Changed ]]; then changed=$(( changed + BASH_REMATCH[1] )); fi
    if [[ "$line" =~ ([0-9]+)[[:space:]]Added ]];   then added=$(( added + BASH_REMATCH[1] ));   fi
  done < <(grep -E 'changes summary:' "$REPORT_PATH" || true)
fi

verdict=""
summary=""
if (( EXIT_CODE & (ABIDIFF_ERROR | ABIDIFF_USAGE_ERROR) )); then
  verdict="error"
elif (( EXIT_CODE & ABIDIFF_ABI_INCOMPATIBLE_CHANGE )); then
  verdict="incompatible"
elif (( EXIT_CODE & ABIDIFF_ABI_CHANGE )); then
  if (( removed > 0 || changed > 0 )); then
    verdict="incompatible"
    summary="ABI changed: ${removed} removed, ${changed} changed, ${added} added declaration(s); removed or changed declarations break backward compatibility."
  elif (( added > 0 )); then
    verdict="additions-only"
  else
    # abidiff says the ABIs differ, but the report could not be classified
    # (missing report file or unrecognized format). Fail safe: never call a
    # potentially breaking change additions-only.
    echo "::warning::abidiff reported an ABI change (exit=${EXIT_CODE}) but no changes-summary lines could be parsed from the report (${REPORT_PATH:-unset}); treating as incompatible."
    verdict="incompatible"
    summary="ABI changed but the report could not be classified; treating as incompatible."
  fi
elif (( EXIT_CODE == 0 )); then
  verdict="compatible"
else
  verdict="error"
fi

if [[ -z "$summary" ]]; then
  case "$verdict" in
    compatible)     summary="No ABI changes detected." ;;
    additions-only) summary="ABI changed but only with additions (backward-compatible)." ;;
    incompatible)   summary="ABI-incompatible changes detected." ;;
    error)          summary="abidiff reported an error (exit=${EXIT_CODE}); ABI verdict is undetermined." ;;
  esac
fi

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
