# Tiny fixtures for libabigail-action CI / local smoke testing.
#
#   make            -> builds build/*.so
#   make clean      -> removes build/
#
# The foo variants exercise the abidiff verdicts:
#   v1 vs v1  -> compatible
#   v1 vs v2  -> additions-only  (new symbol added)
#   v1 vs v3  -> incompatible    (parameter types changed => symbol removed)
#   v1 vs v4  -> incompatible    (return type changed => same symbol, exit
#                                 bit 4 only; classified from the report)
#
# The pimpl and byvalue variants exercise the public-headers-regexp input
# (test/test-public-headers.sh); their sources carry the details:
#   pimpl-base vs pimpl-private  -> additions-only with the regexp, incompatible
#                                   without it
#   pimpl-base vs pimpl-public   -> incompatible (public data member added)
#   byvalue-base vs byvalue-dep  -> incompatible (private type by value grew)
CXX      ?= g++
CXXFLAGS ?= -g -O0 -fPIC -Wall -Wextra
LDFLAGS  ?= -shared
BUILD    ?= build

TARGETS  := $(BUILD)/libfoo-v1.so \
            $(BUILD)/libfoo-v2.so \
            $(BUILD)/libfoo-v3.so \
            $(BUILD)/libfoo-v4.so \
            $(BUILD)/libpimpl-base.so \
            $(BUILD)/libpimpl-private.so \
            $(BUILD)/libpimpl-public.so \
            $(BUILD)/libbyvalue-base.so \
            $(BUILD)/libbyvalue-dep.so

.PHONY: all clean
all: $(TARGETS)

$(BUILD):
	@mkdir -p $(BUILD)

$(BUILD)/libfoo-v1.so: v1/foo.cpp v1/foo.h | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -Iv1 -o $@ v1/foo.cpp

$(BUILD)/libfoo-v2.so: v2_additions/foo.cpp v2_additions/foo.h | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -Iv2_additions -o $@ v2_additions/foo.cpp

$(BUILD)/libfoo-v3.so: v3_breaking/foo.cpp v3_breaking/foo.h | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -Iv3_breaking -o $@ v3_breaking/foo.cpp

$(BUILD)/libfoo-v4.so: v4_changed/foo.cpp v4_changed/foo.h | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -Iv4_changed -o $@ v4_changed/foo.cpp

# The source paths are deliberately relative: the DWARF then records
# pimpl/include/foo/foo.hpp (public) and pimpl/src/scheduler.hpp (private),
# which is what the public-headers regexp of the tests, (^|/)include/, keys on.
PIMPL_SRC := pimpl/src/foo.cpp pimpl/src/scheduler.hpp pimpl/include/foo/foo.hpp

$(BUILD)/libpimpl-base.so: $(PIMPL_SRC) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -Ipimpl/include -o $@ pimpl/src/foo.cpp

$(BUILD)/libpimpl-private.so: $(PIMPL_SRC) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -DPIMPL_CHANGE -Ipimpl/include -o $@ pimpl/src/foo.cpp

$(BUILD)/libpimpl-public.so: $(PIMPL_SRC) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -DPUBLIC_CHANGE -Ipimpl/include -o $@ pimpl/src/foo.cpp

BYVALUE_SRC := byvalue/src/bar.cpp byvalue/include/bar/bar.hpp byvalue/depinc/dep/dep.h

$(BUILD)/libbyvalue-base.so: $(BYVALUE_SRC) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -Ibyvalue/include -Ibyvalue/depinc -o $@ byvalue/src/bar.cpp

$(BUILD)/libbyvalue-dep.so: $(BYVALUE_SRC) | $(BUILD)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -DDEP_CHANGE -Ibyvalue/include -Ibyvalue/depinc -o $@ byvalue/src/bar.cpp

clean:
	$(RM) -r $(BUILD)
