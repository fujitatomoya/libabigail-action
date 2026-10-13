// Public header of the pimpl fixture (test/fixtures/pimpl).
//
// Foo keeps its state behind an opaque pointer; Impl and Worker are defined in
// src/scheduler.hpp, which is not a public header. Built three ways:
//
//   (default)         baseline
//   -DPIMPL_CHANGE    private layout changes, a private member function is
//                     removed and others are added -> no ABI change for users
//                     of this header; abidiff alone still calls it a break
//   -DPUBLIC_CHANGE   a data member is added to Foo itself -> ABI break
#pragma once
#include <memory>

namespace foo
{

class Worker;

class Foo
{
public:
  Foo();
  ~Foo();
  int run();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
#ifdef PUBLIC_CHANGE
  int pub_;
#endif
};

}  // namespace foo
