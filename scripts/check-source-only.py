"""Reject firmware and binary artifacts from public source/package inputs."""
from pathlib import Path
import argparse
import os
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--include-dist", action="store_true")
args = parser.parse_args()
excluded = {"node_modules", ".git", "release", "dist", "build", "__pycache__"}
blocked = {".bin", ".rom", ".hex", ".fw", ".img", ".dump", ".elf", ".exe",
           ".dll", ".so", ".dylib", ".zip", ".gz", ".tar", ".7z", ".uf2", ".hex32"}
files = set()
# Do not inspect a parent workspace's Git index.
if (root / ".git").exists():
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
    files.update(Path(p.decode()) for p in tracked.split(b"\0") if p)
for parent, directories, names in os.walk(root):
    # Prune build/dependency trees instead of traversing them and filtering later.
    for directory in list(directories):
        path = Path(parent) / directory
        if path.is_symlink() and directory not in excluded:
            files.add(path.relative_to(root))
        if directory in excluded or path.is_symlink():
            directories.remove(directory)
    files.update((Path(parent) / name).relative_to(root) for name in names)
if args.include_dist:
    files.update(file.relative_to(root) for file in (root / "dist").rglob("*") if file.is_file())
errors = []
for relative in sorted(files):
    file = root / relative
    if file.is_symlink():
        errors.append(f"{relative}: symlink is not a source file")
        continue
    if relative.suffix.lower() in blocked:
        errors.append(f"{relative}: binary/firmware extension")
        continue
    if not file.is_file():
        errors.append(f"{relative}: tracked file missing")
        continue
    data = file.read_bytes()
    if data.startswith(b"\x3c\xc3") or b"\0" in data:
        errors.append(f"{relative}: firmware header or binary data")
        continue
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        errors.append(f"{relative}: non-UTF-8 source data")
if errors:
    print("Source-only check FAILED:\n" + "\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"Source-only check passed: {len(files)} text files; no firmware or binary artifacts.")
