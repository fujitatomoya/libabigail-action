#include "foo.h"

namespace libfoo {

int add(int a, int b) { return a + b; }

long multiply(int a, int b) { return static_cast<long>(a) * b; }

}  // namespace libfoo
