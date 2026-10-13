#include "scheduler.hpp"

namespace foo
{

#ifdef PIMPL_CHANGE
void Worker::block_for(int ns) {id_ += ns;}
void Worker::unblock() {extra_++;}
int Foo::Impl::tick() {return count++ + static_cast<int>(queue.size());}
#else
void Worker::block() {id_++;}
int Foo::Impl::tick() {return count++ + (release ? 1 : 0);}
#endif
int Worker::id() const {return id_;}

Foo::Foo()
: impl_(new Impl{})
#ifdef PUBLIC_CHANGE
  , pub_(0)
#endif
{}
Foo::~Foo() = default;
int Foo::run() {return impl_->tick();}

}  // namespace foo
