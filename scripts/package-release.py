"""Package the browser source without distributing firmware or binaries."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
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


source_names = ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json",
                "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html",
                ".gitignore", ".gitattributes"]
source_files = [(root / name, name) for name in source_names]
for directory in ["src", "scripts", "tests", "public", ".github"]:
    for file in sorted((root / directory).rglob("*")):
        if (file.is_file() and "__pycache__" not in file.parts
                and not file.name.endswith(".test-bundle.mjs")):
            source_files.append((file, str(file.relative_to(root))))
write_archive(release / f"MS2133-Web-{version}-source.zip", source_files)
manifest = release / f"MS2133-Flasher-{version}-packages.json"
temporary = manifest.with_name(manifest.name + ".tmp")
temporary.write_text(json.dumps(outputs, ensure_ascii=False, indent=2) + "\n")
os.replace(temporary, manifest)
print(json.dumps(outputs, ensure_ascii=False, indent=2))
