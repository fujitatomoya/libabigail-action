// Dependency header of the by-value fixture; -DDEP_CHANGE grows the struct.
#pragma once

typedef struct dep_s
{
  int a;
#ifdef DEP_CHANGE
  long b;
#endif
} dep_t;
