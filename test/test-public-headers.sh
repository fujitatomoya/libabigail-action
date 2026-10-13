#!/usr/bin/env bash
#
# Tests for the public-headers-regexp input: scripts/public-headers-suppressions.py
# feeding scripts/run-abidiff.sh and scripts/decode-verdict.sh, against the
# pimpl and byvalue fixtures (test/fixtures). Needs g++, abidiff and abidw.
# Runs locally and in ci.yml:
#
#   bash test/test-public-headers.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures"
BUILD="$FIXTURES/build"
RUN="$ROOT/scripts/run-abidiff.sh"
DECODE="$ROOT/scripts/decode-verdict.sh"
GEN="$ROOT/scripts/public-headers-suppressions.py"
PUBLIC='(^|/)include/'

# Never append to a real $GITHUB_OUTPUT when running inside a workflow step.
unset GITHUB_OUTPUT

for tool in abidiff abidw g++ python3; do
  command -v "$tool" >/dev/null || { echo "SKIP: $tool not found"; exit 0; }
done
make -s -C "$FIXTURES" >/dev/null

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failed=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1: $2"; failed=$(( failed + 1 )); }

# diff <name> <base.so> <head.so> <regexp or -> ; sets $verdict, $exit_code, $report
diff_libs() {
  local name="$1" base="$2" head="$3" regexp="$4" dir out
  dir="$WORK/$name"; mkdir -p "$dir"
  report="$dir/abidiff-report.txt"
  [[ "$regexp" == "-" ]] && regexp=""
  if ! out="$(BASE_LIB="$BUILD/$base" HEAD_LIB="$BUILD/$head" REPORT_PATH="$report" \
              PUBLIC_HEADERS_REGEXP="$regexp" UNREFERENCED_SYMBOLS=false bash "$RUN" 2>&1)"; then
    echo "$out"; fail "$name" "run-abidiff.sh exited non-zero"; return 1
  fi
  exit_code="$(sed -n 's/^abidiff-exit=//p' <<<"$out" | tail -n 1)"
  out="$(ABIDIFF_EXIT="$exit_code" REPORT_PATH="$report" FAIL_ON=incompatible bash "$DECODE" 2>&1)"
  verdict="$(sed -n 's/^verdict=//p' <<<"$out" | tail -n 1)"
}

# check <name> <base> <head> <regexp or -> <expected verdict> [expected exit]
check() {
  local name="$1" base="$2" head="$3" regexp="$4" want="$5" want_exit="${6:-}"
  diff_libs "$name" "$base" "$head" "$regexp" || return 0
  if [[ "$verdict" != "$want" ]]; then
    fail "$name" "verdict '$verdict' (exit $exit_code), expected '$want'"
    sed 's/^/     | /' "$report"
  elif [[ -n "$want_exit" && "$exit_code" != "$want_exit" ]]; then
    fail "$name" "abidiff exit $exit_code, expected $want_exit"
  else
    pass "$name"
  fi
}

# The pimpl change alone is a break for abidiff ...
check "pimpl change without the regexp is a break" \
  libpimpl-base.so libpimpl-private.so - incompatible 12
# ... and implementation detail with the regexp: the removed private member
# function and the private layout changes are filtered, what is left are
# additions (the new private members and libstdc++ instantiations).
check "pimpl change with the regexp is additions-only" \
  libpimpl-base.so libpimpl-private.so "$PUBLIC" additions-only 4
# A data member added to the public class is still a break.
check "public data member insertion stays a break" \
  libpimpl-base.so libpimpl-public.so "$PUBLIC" incompatible
# A private type embedded by value in a public type: growing it grows the
# public type, which the accessed_through restriction keeps visible.
check "private type by value still reports the layout change" \
  libbyvalue-base.so libbyvalue-dep.so "$PUBLIC" incompatible
# Sanity: the same libraries are compatible with the regexp as well.
check "identical libraries are compatible with the regexp" \
  libpimpl-base.so libpimpl-base.so "$PUBLIC" compatible 0

# The generated spec: one function/variable pair per private class with
# exported members, the public class absent, the type entry with its
# accessed_through restriction.
name="generated spec lists the private classes only"
spec="$WORK/spec.abignore"
if python3 "$GEN" --public-regexp "$PUBLIC" --output "$spec" \
     "$BUILD/libpimpl-base.so" "$BUILD/libpimpl-private.so" 2>/dev/null \
   && grep -q '^  name_regexp = ^foo::Worker::$' "$spec" \
   && grep -q '^  name_regexp = ^foo::Foo::Impl::$' "$spec" \
   && ! grep -q 'name_regexp = ^foo::Foo::$' "$spec" \
   && grep -q '^  source_location_not_regexp = (^|/)include/$' "$spec" \
   && grep -q '^  accessed_through = reference-or-pointer$' "$spec"; then
  pass "$name"
else
  fail "$name" "unexpected content"; sed 's/^/     | /' "$spec"
fi

# ERE escaping of template class names: '<' and '>' must stay literal (Python's
# re.escape would turn them into GNU word boundaries), '.' and '(' escaped.
name="regexp escaping follows POSIX ERE"
got="$(python3 - "$GEN" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("gen", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
print(mod.ere_escape("ns::Tpl<int, a::B*>::{lambda(int)#1}"))
PY
)"
want='ns::Tpl<int, a::B\*>::\{lambda\(int\)#1\}'
if [[ "$got" == "$want" ]]; then pass "$name"; else fail "$name" "got '$got', want '$want'"; fi

# The generated spec travels with the report so it can be inspected later.
name="generated spec is written next to the report"
diff_libs "$name" libpimpl-base.so libpimpl-private.so "$PUBLIC" || true
if [[ -f "$(dirname "$report")/public-headers.abignore" ]]; then pass "$name"; else fail "$name" "missing"; fi

# An unusable regexp is reported as a run error (exit 2), not a verdict.
name="invalid regexp fails run-abidiff.sh"
if BASE_LIB="$BUILD/libpimpl-base.so" HEAD_LIB="$BUILD/libpimpl-private.so" \
   REPORT_PATH="$WORK/bad/abidiff-report.txt" PUBLIC_HEADERS_REGEXP='(' \
   bash "$RUN" >/dev/null 2>&1; then
  fail "$name" "exited zero"
else
  pass "$name"
fi

# Known libabigail limitation, kept here as a trip-wire: when a public class
# both gains a data member AND holds a pointer to a private type that changed,
# libabigail suppresses the whole class diff (a node whose changed children
# are all suppressed is suppressed too, inserted members do not count). The
# README documents this. When this check starts failing, libabigail fixed it:
# update the README and turn the expectation into 'incompatible'.
(cd "$FIXTURES" && g++ -g -O0 -fPIC -shared -DPIMPL_CHANGE -DPUBLIC_CHANGE \
   -Ipimpl/include -o "$WORK/libpimpl-both.so" pimpl/src/foo.cpp)
cp "$WORK/libpimpl-both.so" "$BUILD/libpimpl-both.so"
check "LIMITATION: public insertion next to a pimpl change is swallowed (libabigail)" \
  libpimpl-base.so libpimpl-both.so "$PUBLIC" additions-only
rm -f "$BUILD/libpimpl-both.so"

if (( failed > 0 )); then
  echo "$failed test(s) failed"
  exit 1
fi
echo "all tests passed"
