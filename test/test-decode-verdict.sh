#!/usr/bin/env bash
#
# Unit tests for scripts/decode-verdict.sh: an abidiff exit code plus a
# canned report (test/reports/*.txt) must decode into the expected verdict,
# summary and should-fail flag. Runs locally and in ci.yml:
#
#   bash test/test-decode-verdict.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DECODE="$ROOT/scripts/decode-verdict.sh"
REPORTS="$ROOT/test/reports"

# Never append to a real $GITHUB_OUTPUT when running inside a workflow step.
unset GITHUB_OUTPUT

failed=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1: $2"; failed=$(( failed + 1 )); }

# check <name> <exit-code> <report file or -> <fail-on> <verdict> <should-fail> [summary substring]
check() {
  local name="$1" code="$2" report="$3" fail_on="$4" want="$5" want_fail="$6" want_summary="${7:-}"
  local path="" out verdict should summary
  [[ "$report" != "-" ]] && path="$REPORTS/$report"
  if ! out="$(ABIDIFF_EXIT="$code" REPORT_PATH="$path" FAIL_ON="$fail_on" bash "$DECODE" 2>&1)"; then
    fail "$name" "decode-verdict.sh exited non-zero: $out"
    return
  fi
  verdict="$(sed -n 's/^verdict=//p' <<<"$out" | tail -n 1)"
  should="$(sed -n 's/^should-fail=//p' <<<"$out" | tail -n 1)"
  summary="$(sed -n 's/^summary=//p' <<<"$out" | tail -n 1)"
  if [[ "$verdict" != "$want" ]]; then
    fail "$name" "verdict '$verdict', expected '$want' ($summary)"
  elif [[ "$should" != "$want_fail" ]]; then
    fail "$name" "should-fail '$should', expected '$want_fail'"
  elif [[ -n "$want_summary" && "$summary" != *"$want_summary"* ]]; then
    fail "$name" "summary '$summary' does not contain '$want_summary'"
  else
    pass "$name"
  fi
}

# Bitmap-only cases.
check "exit 0 is compatible"                          0  -  incompatible compatible   false
check "bit 8 is incompatible whatever the report"     12 removed.txt            incompatible incompatible true
check "bit 8 without a report is incompatible"        8  -  incompatible incompatible true
check "ABIDIFF_ERROR is an error and always fails"    1  -  none         error        true
check "ABIDIFF_USAGE_ERROR is an error"               2  -  none         error        true

# Bit 4 only: the report decides.
check "additions only"                                4  additions-only.txt     incompatible additions-only false \
  "only with additions"
check "a changed return type is a break"              4  changed-return-type.txt incompatible incompatible true \
  "0 removed, 1 changed, 0 added"
check "changed declarations with only filtered sub-type changes are not a break" \
                                                      4  changed-filtered-only.txt incompatible additions-only false \
  "2 changed declaration(s) carry only filtered"
check "one concrete change among filtered ones is a break" \
                                                      4  changed-mixed.txt      incompatible incompatible true \
  "0 removed, 2 changed, 1 added"
check "bit 4 without a report is a fail-safe incompatible" \
                                                      4  -  incompatible incompatible true "could not be classified"

# fail-on policy.
check "fail-on none never fails a classified verdict" 4  changed-return-type.txt none         incompatible false
check "fail-on addition fails additions"              4  additions-only.txt     addition     additions-only true
check "fail-on change fails additions"                4  additions-only.txt     change       additions-only true
check "fail-on incompatible passes additions"         4  changed-filtered-only.txt incompatible additions-only false

if (( failed )); then
  echo "$failed test(s) failed"
  exit 1
fi
echo "all decode-verdict tests passed"
