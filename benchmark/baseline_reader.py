#!/usr/bin/env python3
"""
Baseline KB reader: simulates the common "skill + Python script" approach — a skill
tells the agent to use this script to search/read the knowledge base. Every call is a
fresh process that scans the tree on disk; matched/whole file contents are printed to
stdout and land in the agent's context permanently (no unload mechanism exists).

Usage:
  python3 baseline_reader.py search <root> <keyword>   # recursive scan, print hits
  python3 baseline_reader.py read <root> <relpath>     # print one whole file
"""
import os
import re
import sys

SKIP_DIRS = {"node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".cache", "coverage", ".hg", ".svn"}
MAX_HITS = 50  # naive scripts usually cap crudely, if at all


def search(root: str, keyword: str) -> int:
    pat = re.compile(re.escape(keyword), re.IGNORECASE)
    printed = 0
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in sorted(filenames):
            if not name.lower().endswith(".md"):
                continue
            path = os.path.join(dirpath, name)
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError:
                continue
            scanned += len(text.encode("utf-8"))
            for lineno, line in enumerate(text.splitlines(), 1):
                if printed >= MAX_HITS:
                    print(f"... (output capped at {MAX_HITS} hits)")
                    return scanned
                if pat.search(line):
                    rel = os.path.relpath(path, root)
                    print(f"{rel}:{lineno}: {line.strip()[:200]}")
                    printed += 1
    if printed == 0:
        print(f"no matches for '{keyword}'")
    return scanned


def read(root: str, relpath: str) -> None:
    with open(os.path.join(root, relpath), encoding="utf-8", errors="replace") as f:
        sys.stdout.write(f.read())


def main() -> None:
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    cmd, root, arg = sys.argv[1], sys.argv[2], sys.argv[3]
    if cmd == "search":
        search(root, arg)
    elif cmd == "read":
        read(root, arg)
    else:
        print(f"unknown command: {cmd}")
        sys.exit(2)


if __name__ == "__main__":
    main()
