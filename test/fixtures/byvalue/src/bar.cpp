#include "bar/bar.hpp"

namespace bar
{

Bar::Bar()
: d_{} {}
int Bar::get() const {return d_.a;}

}  // namespace bar
