# Tiny fixtures for libabigail-action CI / local smoke testing.
#
#   make            -> builds build/libfoo-v{1,2,3}.so
#   make clean      -> removes build/
#
# The variants exercise the abidiff verdicts:
#   v1 vs v1  -> compatible
#   v1 vs v2  -> additions-only  (new symbol added)
#   v1 vs v3  -> incompatible    (parameter types changed => symbol removed)
#   v1 vs v4  -> incompatible    (return type changed => same symbol, exit
#                                 bit 4 only; classified from the report)
CXX      ?= g++
CXXFLAGS ?= -g -O0 -fPIC -Wall -Wextra
LDFLAGS  ?= -shared
BUILD    ?= build

VARIANTS := v1 v2_additions v3_breaking v4_changed
TARGETS  := $(BUILD)/libfoo-v1.so \
            $(BUILD)/libfoo-v2.so \
            $(BUILD)/libfoo-v3.so \
            $(BUILD)/libfoo-v4.so

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

clean:
	rm -rf $(BUILD)
