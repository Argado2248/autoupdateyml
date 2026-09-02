#!/usr/bin/env python3
"""Parse every YAML file in the repo and fail on the first that is invalid."""
import pathlib
import sys

import yaml

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build"}


def main() -> int:
    errors = []
    checked = 0
    for path in sorted(pathlib.Path(".").rglob("*.y*ml")):
        if SKIP_DIRS.intersection(path.parts):
            continue
        checked += 1
        try:
            list(yaml.safe_load_all(path.read_text(encoding="utf-8")))
        except yaml.YAMLError as exc:
            errors.append(f"{path}: {exc}")

    for err in errors:
        print(err, file=sys.stderr)
    print(f"checked {checked} YAML file(s), {len(errors)} invalid")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
