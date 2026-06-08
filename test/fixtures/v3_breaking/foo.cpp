#include "foo.h"

namespace libfoo {

int add(int a, int b) { return a + b; }

int multiply(long a, long b) { return static_cast<int>(a * b); }

}  // namespace libfoo
