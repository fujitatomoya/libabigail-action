#!/usr/bin/env bash
# Write the decoded verdict as machine-readable JSON next to the abidiff
# report, so that a trusted publisher running later (publish/ via
# workflow_run) can post the comment and labels without re-running abidiff.
#
# The file is uploaded together with the report in the report artifact. Its
# content is produced in the (possibly untrusted) pull_request context, so the
# publisher treats every field as data: verdict is validated against the known
# set, report is resolved as a basename only, everything else is displayed.
#
# All configuration is provided via env vars set by action.yml.

set -euo pipefail

: "${VERDICT_PATH:?VERDICT_PATH must be set}"
VERDICT="${VERDICT:-error}"
SUMMARY="${SUMMARY:-}"
EXIT_CODE="${ABIDIFF_EXIT:-0}"
FAIL_ON="${FAIL_ON:-incompatible}"
SHOULD_FAIL="${SHOULD_FAIL:-true}"
BASE_LIB="${BASE_LIB:-}"
HEAD_LIB="${HEAD_LIB:-}"
SUPPRESSIONS="${SUPPRESSIONS:-}"
REPORT_PATH="${REPORT_PATH:-}"
HEAD_SHA="${HEAD_SHA:-}"
LIBRARY="${LIBRARY:-}"

# Display name of the library under test; the head file name unless given.
if [[ -z "$LIBRARY" ]]; then
  LIBRARY="$(basename -- "$HEAD_LIB")"
fi

# Minimal JSON string escaping in pure bash: backslash and double quote are
# escaped, newlines / tabs become escapes, other control characters are
# dropped. Enough for paths and the one-line summaries decode-verdict.sh emits.
json_str() {
  local s="$1"
  s="$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

json_bool() {
  if [[ "$1" == "true" ]]; then printf 'true'; else printf 'false'; fi
}

if ! [[ "$EXIT_CODE" =~ ^[0-9]+$ ]]; then
  EXIT_CODE=0
fi

report_name=""
if [[ -n "$REPORT_PATH" ]]; then
  report_name="$(basename -- "$REPORT_PATH")"
fi

mkdir -p "$(dirname -- "$VERDICT_PATH")"
{
  printf '{\n'
  printf '  "schema": 1,\n'
  printf '  "library": %s,\n'      "$(json_str "$LIBRARY")"
  printf '  "verdict": %s,\n'      "$(json_str "$VERDICT")"
  printf '  "summary": %s,\n'      "$(json_str "$SUMMARY")"
  printf '  "exit_code": %s,\n'    "$EXIT_CODE"
  printf '  "fail_on": %s,\n'      "$(json_str "$FAIL_ON")"
  printf '  "should_fail": %s,\n'  "$(json_bool "$SHOULD_FAIL")"
  printf '  "base_lib": %s,\n'     "$(json_str "$BASE_LIB")"
  printf '  "head_lib": %s,\n'     "$(json_str "$HEAD_LIB")"
  printf '  "suppressions": %s,\n' "$(json_str "$SUPPRESSIONS")"
  printf '  "report": %s,\n'       "$(json_str "$report_name")"
  printf '  "head_sha": %s\n'      "$(json_str "$HEAD_SHA")"
  printf '}\n'
} > "$VERDICT_PATH"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "verdict-path=${VERDICT_PATH}" >> "$GITHUB_OUTPUT"
fi
echo "verdict-path=${VERDICT_PATH}"
echo "::group::verdict.json"
cat "$VERDICT_PATH"
echo "::endgroup::"
