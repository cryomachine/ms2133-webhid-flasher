"""Package source and optional launchers without distributing firmware."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-only", action="store_true", help="no launcher build required")
args = parser.parse_args()
subprocess.run([os.sys.executable, str(root / "scripts/check-source-only.py")], check=True)
release = root / "release"
release.mkdir(exist_ok=True)
version = json.loads((root / "package.json").read_text())["version"]
outputs = []


def write_archive(archive, files):
    temporary = archive.with_name(archive.name + ".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for file, name in files:
            package.write(file, name)
    os.replace(temporary, archive)
    outputs.append({"file": archive.name, "bytes": archive.stat().st_size,
                    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()})


if not args.source_only:
    subprocess.run([os.sys.executable, str(root / "scripts/check-source-only.py"),
                    "--include-dist"], check=True)
    targets = {
        "macos-arm64": "MS2133 Flasher macOS-arm64.app",
        "macos-amd64": "MS2133 Flasher macOS-amd64.app",
        "windows-amd64": "ms2133-flasher-windows-amd64.exe",
        "linux-amd64": "ms2133-flasher-linux-amd64",
        "linux-arm64": "ms2133-flasher-linux-arm64",
    }
    for target, entry in targets.items():
        files = [(root / name, name) for name in ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]]
        path = release / entry
        if path.is_dir():
            files.extend((file, str(file.relative_to(release))) for file in sorted(path.rglob("*")) if file.is_file())
        else:
            files.append((path, path.name))
        write_archive(release / f"MS2133-Flasher-{version}-{target}.zip", files)

source_names = ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json",
                "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html",
                "go.mod", "launcher.go", "build-launchers.sh", ".gitignore", ".gitattributes"]
source_files = [(root / name, name) for name in source_names]
for directory in ["src", "scripts", "tests", "public", ".github"]:
    for file in sorted((root / directory).rglob("*")):
        if (file.is_file() and "__pycache__" not in file.parts
                and not file.name.endswith(".test-bundle.mjs")):
            source_files.append((file, str(file.relative_to(root))))
write_archive(release / f"MS2133-Flasher-{version}-source.zip", source_files)
manifest = release / f"MS2133-Flasher-{version}-packages.json"
temporary = manifest.with_name(manifest.name + ".tmp")
temporary.write_text(json.dumps(outputs, ensure_ascii=False, indent=2) + "\n")
os.replace(temporary, manifest)
print(json.dumps(outputs, ensure_ascii=False, indent=2))
