#pragma once
// libfoo v4 — modified declaration, same exported symbols as v1.
// multiply()'s return type changed from int to long. The C++ mangled name
// encodes parameter types but NOT the return type, so the v1 symbol
//   _ZN6libfoo8multiplyEii
// is still exported unchanged. abidiff sees the change only through DWARF
// and reports "1 Changed" with ABIDIFF_ABI_CHANGE alone (bit 4, no bit 8):
// "possibly incompatible, needs human review". This mirrors real-world
// breaks like an extern "C" function whose parameter type changes — the
// symbol survives, but callers built against v1 misuse the new ABI.
namespace libfoo {

int add(int a, int b);
long multiply(int a, int b);  // CHANGED: return type int -> long

}  // namespace libfoo
