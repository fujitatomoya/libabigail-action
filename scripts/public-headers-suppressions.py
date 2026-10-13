#!/usr/bin/env python3
"""Generate a libabigail suppression spec for "public headers are the ABI".

The policy: a declaration is part of the ABI only when it comes from a public
header, i.e. a file whose path matches PUBLIC_REGEXP. Everything declared in
other files (headers under src/, types local to a .cpp) is implementation and
may change freely, which is what the pimpl idiom relies on.

abidiff cannot enforce that alone. Its --headers-dir options only generate a
*type* suppression, so member functions of a class defined in a private header
are still reported when they are added or removed, and no [suppress_function]
property selects a function by the file it is declared in. This script
therefore writes two kinds of entries:

  [suppress_type]
      source_location_not_regexp = PUBLIC_REGEXP
      accessed_through = reference-or-pointer
    Changes to a type defined outside the public headers are hidden, but only
    where that type is reached through a pointer or a reference (an opaque
    handle, a unique_ptr<Impl>). A private type embedded *by value* in a public
    type changes that type's layout and stays reported.

  [suppress_function] / [suppress_variable]
      name_regexp = ^<qualified class name>::
    One pair per class, struct or union defined outside the public headers that
    has exported member functions or static data members. Their symbols may
    come and go without being an ABI change.

The private classes are discovered from the ABI representation that abidw
emits for each library given (both sides, so members that only exist on the
head side are covered too). abidw records the declaring file on the class
(class-decl filepath) and on member functions, while free functions carry the
file of their *definition*; free functions are therefore never touched here
and a free function declared only in a private header still needs a manual
suppression.

Limitation (libabigail): a public class whose only changed child is a
suppressed private type is itself filtered even when it also gained a data
member or changed size. See the README.

Usage:
  public-headers-suppressions.py --public-regexp RE --output FILE LIB [LIB...]
"""

import argparse
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

# Characters that are special in a POSIX extended regular expression, which is
# what libabigail compiles name_regexp with. Python's re.escape() escapes far
# more ("\<" is a GNU word boundary in an ERE), so escape by hand.
ERE_SPECIAL = set(".^$*+?()[]{}|\\")


def ere_escape(text):
    return "".join("\\" + c if c in ERE_SPECIAL else c for c in text)


def run_abidw(lib, out):
    """Write abidw's XML for lib into the open file object out."""
    subprocess.run(["abidw", lib], stdout=out, check=True)


def private_classes(abi_xml, public_re):
    """Return the qualified names of classes defined outside the public headers
    that have at least one exported member function or static data member.

    abi_xml is an open binary file positioned at the start of abidw output.
    The document is streamed, so libraries whose representation is hundreds of
    megabytes do not have to fit in memory as a tree.
    """
    found = {}  # qualified name -> None, insertion ordered
    # One entry per open namespace / class scope:
    #   [kind, name, qualified name, is private, has exported members]
    scopes = []

    for event, el in ET.iterparse(abi_xml, events=("start", "end")):
        tag = el.tag
        if event == "start":
            if tag == "namespace-decl":
                name = el.get("name", "")
                qual = "::".join([s[1] for s in scopes if s[1]] + [name])
                scopes.append(["ns", name, qual, False, False])
            elif tag in ("class-decl", "union-decl"):
                name = el.get("name", "")
                qual = "::".join([s[1] for s in scopes if s[1]] + [name])
                path = el.get("filepath")
                # A class nested in a private class is private; otherwise the
                # defining file decides. Declaration-only classes carry no
                # location and are left alone.
                private = any(s[3] for s in scopes if s[0] == "class")
                if not private and path:
                    private = public_re.search(path) is None
                scopes.append(["class", name, qual, private, False])
            elif tag in ("function-decl", "var-decl"):
                if el.get("elf-symbol-id") or el.get("mangled-name"):
                    # The innermost enclosing class owns this member. Members
                    # at namespace scope (free functions, globals) have no
                    # class scope and are ignored.
                    for s in reversed(scopes):
                        if s[0] == "class":
                            s[4] = True
                            break
            continue

        # end events
        if tag == "namespace-decl":
            scopes.pop()
        elif tag in ("class-decl", "union-decl"):
            s = scopes.pop()
            if s[3] and s[4] and s[1] and not s[1].startswith("__anonymous"):
                found.setdefault(s[2])
        el.clear()
    return list(found)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--public-regexp",
        required=True,
        help="regular expression matched against the path of the file a "
        "declaration comes from; a match means 'public header'",
    )
    parser.add_argument("--output", required=True, help="suppression file to write")
    parser.add_argument("libs", nargs="+", metavar="LIB", help="shared libraries to scan")
    args = parser.parse_args(argv)

    try:
        public_re = re.compile(args.public_regexp)
    except re.error as exc:
        parser.error(f"invalid --public-regexp: {exc}")

    classes = {}
    for lib in args.libs:
        with tempfile.TemporaryFile() as tmp:
            try:
                run_abidw(lib, tmp)
            except (OSError, subprocess.CalledProcessError) as exc:
                print(f"::error::abidw failed on {lib}: {exc}", file=sys.stderr)
                return 1
            tmp.seek(0)
            names = private_classes(tmp, public_re)
        print(
            f"{lib}: {len(names)} class(es) with exported members defined "
            "outside the public headers",
            file=sys.stderr,
        )
        for name in names:
            classes.setdefault(name)

    with open(args.output, "w", encoding="utf-8") as out:
        out.write("# Generated by libabigail-action (scripts/public-headers-suppressions.py).\n")
        out.write("# Policy: only declarations from public headers are ABI.\n")
        out.write(f"#   public headers: file path matches  {args.public_regexp}\n")
        for lib in args.libs:
            out.write(f"#   scanned: {lib}\n")
        out.write("\n")
        out.write("# Types defined outside the public headers, when reached through a\n")
        out.write("# pointer or a reference (pimpl, opaque handles). By value they still\n")
        out.write("# change the layout of the public type and are reported.\n")
        out.write("[suppress_type]\n")
        out.write("  label = type defined outside the public headers\n")
        out.write(f"  source_location_not_regexp = {args.public_regexp}\n")
        out.write("  accessed_through = reference-or-pointer\n")
        out.write("\n")
        out.write(f"# Exported members of {len(classes)} class(es) defined outside the public headers.\n")
        for name in classes:
            pattern = "^" + ere_escape(name) + "::"
            out.write("[suppress_function]\n")
            out.write(f"  label = member function of {name}\n")
            out.write(f"  name_regexp = {pattern}\n")
            out.write("[suppress_variable]\n")
            out.write(f"  label = static data member of {name}\n")
            out.write(f"  name_regexp = {pattern}\n")
    print(f"wrote {args.output}: {len(classes)} private class(es)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
