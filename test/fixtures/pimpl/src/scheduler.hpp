// Private header of the pimpl fixture: not installed, so nothing here is ABI.
#pragma once
#include <vector>
#include "foo/foo.hpp"

namespace foo
{

class Worker
{
public:
#ifdef PIMPL_CHANGE
  void block_for(int ns);
  void unblock();
#else
  void block();
#endif
  int id() const;
  int id_;
#ifdef PIMPL_CHANGE
  long extra_;
#endif
};

struct Foo::Impl
{
  std::vector<Worker> workers;
#ifdef PIMPL_CHANGE
  std::vector<Worker *> queue;
#else
  bool release;
#endif
  int count;
  int tick();
};

}  // namespace foo
