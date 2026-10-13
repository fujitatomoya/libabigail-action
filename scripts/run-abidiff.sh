#!/usr/bin/env bash
# Run abidiff with the resolved arguments and capture its full report.
# All configuration is provided via env vars set by action.yml.

set -uo pipefail

: "${BASE_LIB:?BASE_LIB must be set}"
: "${HEAD_LIB:?HEAD_LIB must be set}"
SUPPRESSIONS="${SUPPRESSIONS:-}"
HEADERS_DIR_BASE="${HEADERS_DIR_BASE:-}"
HEADERS_DIR_HEAD="${HEADERS_DIR_HEAD:-}"
PUBLIC_HEADERS_REGEXP="${PUBLIC_HEADERS_REGEXP:-}"
UNREFERENCED_SYMBOLS="${UNREFERENCED_SYMBOLS:-true}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
REPORT_PATH="${REPORT_PATH:-${RUNNER_TEMP:-/tmp}/abidiff-report.txt}"

emit_output() {
  local key="$1" value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "${key}=${value}" >> "$GITHUB_OUTPUT"
  fi
  echo "${key}=${value}"
}

for f in "$BASE_LIB" "$HEAD_LIB"; do
  if [[ ! -f "$f" ]]; then
    echo "::error::Library not found: $f"
    exit 2
  fi
done

if [[ -n "$SUPPRESSIONS" && ! -f "$SUPPRESSIONS" ]]; then
  echo "::error::Suppressions file not found: $SUPPRESSIONS"
  exit 2
fi

# Warn when no DWARF debug info is present; abidiff still runs but its output
# will be limited to symbol tables.
if command -v readelf >/dev/null 2>&1; then
  for f in "$BASE_LIB" "$HEAD_LIB"; do
    if ! readelf -S "$f" 2>/dev/null | grep -qE '\.debug_(info|abbrev)'; then
      echo "::warning::No DWARF debug info found in $f; rebuild with -g for richer ABI reports."
    fi
  done
fi

args=()
[[ -n "$SUPPRESSIONS"      ]] && args+=(--suppressions "$SUPPRESSIONS")
[[ -n "$HEADERS_DIR_BASE"  ]] && args+=(--headers-dir1 "$HEADERS_DIR_BASE")
[[ -n "$HEADERS_DIR_HEAD"  ]] && args+=(--headers-dir2 "$HEADERS_DIR_HEAD")
# ELF symbols without debug info (typically COMDAT template instantiations
# from libstdc++ whose DWARF was dropped) are outside the reach of suppression
# specs: abidiff compares them by symbol table only and treats a removed one
# as an incompatible change. Callers that always build with -g can turn them
# off; the default keeps abidiff's behaviour (libraries without DWARF would
# otherwise diff as empty).
if [[ "${UNREFERENCED_SYMBOLS,,}" == "false" ]]; then
  args+=(--no-unreferenced-symbols)
fi

if [[ -n "$EXTRA_ARGS" ]]; then
  # Word-split on whitespace; user-controlled input.
  # shellcheck disable=SC2206
  extra=( $EXTRA_ARGS )
  args+=("${extra[@]}")
fi

mkdir -p "$(dirname "$REPORT_PATH")"

# "Only public headers are ABI": generate a suppression spec from the regexp
# and the two libraries (types defined elsewhere when reached through a
# pointer or reference, plus the exported members of every class defined
# elsewhere) and add it on top of the caller's own spec. The file is written
# next to the report so it ends up in the report artifact for inspection. See
# scripts/public-headers-suppressions.py for the policy and its limits.
if [[ -n "$PUBLIC_HEADERS_REGEXP" ]]; then
  generated="$(dirname "$REPORT_PATH")/public-headers.abignore"
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! python3 "$script_dir/public-headers-suppressions.py" \
        --public-regexp "$PUBLIC_HEADERS_REGEXP" --output "$generated" \
        "$BASE_LIB" "$HEAD_LIB"; then
    echo "::error::Could not generate the public-headers suppressions (see above)."
    exit 2
  fi
  echo "::group::generated suppressions ($generated)"
  cat "$generated"
  echo "::endgroup::"
  args+=(--suppressions "$generated")
fi

echo "+ abidiff ${args[*]} $BASE_LIB $HEAD_LIB"
set +e
abidiff "${args[@]}" "$BASE_LIB" "$HEAD_LIB" >"$REPORT_PATH" 2>&1
exit_code=$?
set -e

emit_output "abidiff-exit" "$exit_code"
emit_output "report-path"  "$REPORT_PATH"

echo "::group::abidiff report (exit=$exit_code)"
cat "$REPORT_PATH" || true
echo "::endgroup::"

# Always succeed here; fail-on policy is enforced by a later step using the
# decoded verdict, so the artifact and comment steps still run on breaks.
exit 0
