#pragma once
// libfoo v3 — ABI-incompatible change relative to v1.
// multiply()'s parameter types changed from (int, int) to (long, long).
// The C++ mangled symbol name encodes parameter types, so the v1 symbol
//   _ZN6libfoo8multiplyEii
// disappears and a new symbol
//   _ZN6libfoo8multiplyEll
// is exported instead. Callers linked against v1 fail to resolve the old
// symbol, and abidiff reports ABIDIFF_ABI_INCOMPATIBLE_CHANGE.
namespace libfoo {

int add(int a, int b);
int multiply(long a, long b);  // CHANGED: (int, int) -> (long, long)

}  // namespace libfoo
