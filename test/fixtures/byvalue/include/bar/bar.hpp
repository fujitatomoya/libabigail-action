// Public header of the by-value fixture (test/fixtures/byvalue).
//
// Bar embeds a struct from a dependency *by value*. The dependency header
// lives under depinc/, a path that does not match the public-headers regexp
// of the tests, so dep_t counts as a private type. Growing it (-DDEP_CHANGE)
// still grows Bar, which must stay an ABI break: private types are only
// filtered when reached through a pointer or a reference.
#pragma once
#include "dep/dep.h"

namespace bar
{

class Bar
{
public:
  Bar();
  int get() const;

private:
  dep_t d_;
};

}  // namespace bar
