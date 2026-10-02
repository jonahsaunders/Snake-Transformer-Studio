#!/usr/bin/env python3
"""Build verified standalone-source and KiCad PCM packages, using only stdlib.

    python scripts/build_snake_package.py --output-dir dist

Neither package installs itself or modifies a KiCad configuration. Standalone
uses Python 3.9+ and a browser, without pip or an internet connection.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from check_pcm import check_package  # noqa: E402

IDENTIFIER = "com.jonahsaunders.snaketransformerstudio"
NAME = "snake-transformer-studio"


def web_dependencies(root: Path = ROOT) -> list[Path]:
    """Collect the focused UI and its real module/style dependencies."""
    web = (root / "web").resolve()
    pending = [web / "index.html", web / "css/snake.css", web / "snake-icon.svg"]
    pending.extend((web / "js/snake").glob("*.js"))
    seen: set[Path] = set()
    while pending:
        path = pending.pop().resolve()
        if path in seen:
            continue
        if web not in path.parents or not path.is_file():
            raise ValueError(f"Missing or external UI dependency: {path}")
        seen.add(path)
        if path.suffix not in (".html", ".js", ".css"):
            continue
        source = path.read_text(encoding="utf-8")
        refs: list[str] = []
        if path.suffix == ".html":
            refs += re.findall(r'(?:src|href)=[\"\']([^\"\']+)[\"\']', source)
        elif path.suffix == ".js":
            refs += re.findall(r'(?:\bfrom\s*|\bimport\s*\(?\s*|new\s+URL\s*\(\s*)[\"\']([^\"\']+)[\"\']', source)
        else:
            refs += re.findall(r'url\([\"\']?([^\)\"\']+)', source)
            refs += re.findall(r'@import\s+[\"\']([^\"\']+)', source)
        for ref in refs:
            ref = ref.split("?")[0].split("#")[0]
            if not ref or ":" in ref or ref.startswith("//"):
                continue
            if path.suffix == ".js" and not ref.startswith((".", "/")):
                raise ValueError(f"Unbundled module import {ref!r} in {path}")
            pending.append(web / ref.lstrip("/") if ref.startswith("/") else path.parent / ref)
    return sorted(seen)


def runtime_files(root: Path = ROOT) -> list[Path]:
    files = [root / name for name in ("plugin.json", "requirements.txt", "ipc_entry.py", "LICENSE", "README.md")]
    files += sorted((root / "planar_studio").glob("*.py"))
    files += web_dependencies(root)
    files += [root / "resources" / name for name in ("icon-light-24.png", "icon-dark-24.png")]
    # Include only Snake Transformer Studio documentation, never the upstream
    # feature gallery, marketing screenshots, examples or unrelated workspaces.
    for filename in ("QUICKSTART.md", "PROVENANCE.md"):
        if (root / filename).is_file():
            files.append(root / filename)
    files += sorted((root / "docs").glob("snake*.*"))
    release = root / "docs/releases/0.1.0.md"
    if release.is_file():
        files.append(release)
    return sorted(set(files))


def _write_archive(path: Path, files: list[tuple[Path, str]]) -> None:
    names = [name for _, name in files]
    if len(names) != len(set(names)):
        raise ValueError("Duplicate package filenames")
    with ZipFile(path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for source, destination in sorted(files, key=lambda pair: pair[1]):
            if not source.is_file():
                raise ValueError(f"Missing package file: {source}")
            archive.write(source, destination)
    with ZipFile(path, "r") as archive:
        damaged = archive.testzip()
        if damaged:
            raise ValueError(f"Package ZIP integrity check failed: {damaged}")


def build_packages(output_dir: Path, root: Path = ROOT) -> dict[str, Path]:
    root = root.resolve()
    output_dir = output_dir.resolve()
    metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
    manifest = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = metadata["versions"][0]["version"]
    if metadata["identifier"] != IDENTIFIER or manifest["identifier"] != IDENTIFIER:
        raise ValueError("Package identifiers must be isolated from Planar Studio")
    if package["name"] != NAME or package["version"] != version:
        raise ValueError("Package name/version mismatch")
    backend = (root / "planar_studio/__init__.py").read_text(encoding="utf-8")
    if f'__version__ = "{version}"' not in backend:
        raise ValueError("Backend version mismatch")
    output_dir.mkdir(parents=True, exist_ok=True)
    runtime = runtime_files(root)
    pcm = output_dir / f"{NAME}-{version}-kicad.zip"
    standalone = output_dir / f"{NAME}-{version}-standalone.zip"
    _write_archive(pcm, [(root / "metadata.json", "metadata.json"),
                         (root / "resources/icon.png", "resources/icon.png")]
                   + [(source, "plugins/" + source.relative_to(root).as_posix()) for source in runtime])
    check_package(pcm)
    development = [root / name for name in (
        "Start Snake Transformer Studio.cmd", "Start Snake Transformer Studio.sh",
        "metadata.json", "package.json", "package-lock.json",
        "scripts/build_snake_package.py", "scripts/check_pcm.py", "resources/icon.png",
    )]
    development += sorted((root / "tests").glob("snake-*.mjs"))
    development += [root / "tests/test_snake_package.py"]
    _write_archive(standalone, [(source, NAME + "/" + source.relative_to(root).as_posix())
                                for source in sorted(set(runtime + development))])
    sums = output_dir / "SHA256SUMS.txt"
    sums.write_text("".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
                            for path in (pcm, standalone)), encoding="utf-8")
    return {"standalone": standalone, "kicad": pcm, "checksums": sums}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    try:
        packages = build_packages(args.output_dir)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f"Packaging failed: {exc}\n")
    for label, path in packages.items():
        print(f"{label}: {path}")
    print("KiCad PCM layout, identifiers, versions and ZIP integrity verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
