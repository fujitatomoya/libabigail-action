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
#
# One more subtlety: a declaration counted as "Changed" in the summary may
# carry nothing but filtered sub-type changes. With suppressions in effect
# (e.g. a suppress_type on std::), abidiff keeps reporting every function
# whose parameter type contains a suppressed change, but the only detail it
# prints for it is "type size hasn't changed" and "no data member change
# (1 filtered)". Such a declaration is listed as changed, yet abidiff itself
# found nothing it was allowed to report, so it must not be treated as a
# break. The report blocks are scanned for that case (see count_effective).

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

# Count the "[C]" report blocks that contain at least one concrete change
# line. A block starts at an indented "[C] '...'" entry and ends at the next
# "[A]" / "[C]" / "[D]" entry or at the next non-indented line (a section
# header). Inside a block these lines describe no change of their own:
#   - container lines ending in ':' ("return type changed:", "parameter 1 of
#     type 'T' has sub-type changes:", "in pointed to type 'T':", ...); a
#     real change always prints a leaf line underneath them,
#   - "type size hasn't changed",
#   - "no <kind> change(s) (N filtered);",
#   - the symbol alias notes ("Please note that the symbol ...", "and it
#     aliases symbol: ...").
# Everything else ("type name changed from 'int' to 'long int'", "type size
# changed from 32 to 64 (in bits)", "'int y', at offset 32 (in bits)", ...)
# is a concrete change and makes the block count.
count_effective() {
  local report="$1" line trimmed count=0 in_block=0 concrete=0
  local nochange_re='^no .* changes? \([0-9]+ filtered\);?$'
  close_block() {
    if (( in_block && concrete )); then count=$(( count + 1 )); fi
    in_block=0
    concrete=0
  }
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]+\[C\][[:space:]] ]]; then
      close_block
      in_block=1
      continue
    fi
    (( in_block )) || continue
    if [[ "$line" =~ ^[[:space:]]+\[[AD]\][[:space:]] ]] || [[ -n "$line" && ! "$line" =~ ^[[:space:]] ]]; then
      close_block
      continue
    fi
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" ]] && continue
    case "$trimmed" in
      *:) ;;
      "type size hasn't changed") ;;
      "Please note that the symbol"*|"and it aliases symbol"*) ;;
      *)
        if ! [[ "$trimmed" =~ $nochange_re ]]; then
          concrete=1
        fi
        ;;
    esac
  done < "$report"
  close_block
  echo "$count"
}

effective=0
if [[ -n "$REPORT_PATH" && -f "$REPORT_PATH" && "$changed" -gt 0 ]]; then
  effective="$(count_effective "$REPORT_PATH")"
fi
filtered_only=$(( changed - effective ))
if (( filtered_only < 0 )); then filtered_only=0; fi

verdict=""
summary=""
if (( EXIT_CODE & (ABIDIFF_ERROR | ABIDIFF_USAGE_ERROR) )); then
  verdict="error"
elif (( EXIT_CODE & ABIDIFF_ABI_INCOMPATIBLE_CHANGE )); then
  verdict="incompatible"
elif (( EXIT_CODE & ABIDIFF_ABI_CHANGE )); then
  if (( removed > 0 || effective > 0 )); then
    verdict="incompatible"
    summary="ABI changed: ${removed} removed, ${changed} changed, ${added} added declaration(s); removed or changed declarations break backward compatibility."
  elif (( added > 0 || changed > 0 )); then
    verdict="additions-only"
    if (( filtered_only > 0 )); then
      summary="ABI changed but only with additions (backward-compatible): ${added} added declaration(s); ${filtered_only} changed declaration(s) carry only filtered (suppressed or harmless) sub-type changes."
    fi
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
