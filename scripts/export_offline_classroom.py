#!/usr/bin/env python3
"""Export an OpenMAIC classroom to a movable offline HTML package.

This script only reads and copies classroom data. It never deletes classroom
JSON, generated media, job files, or any OpenMAIC server-side data.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
OPENMAIC_DIR = ROOT / "OpenMAIC"
DEFAULT_EXPORTS_DIR = ROOT / "exports"
PNPM_VERSION = "10.28.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export an OpenMAIC classroom as offline HTML.")
    parser.add_argument("classroom_id", help="Classroom id, e.g. G4kNV3OKWI")
    parser.add_argument("--openmaic-dir", type=Path, default=OPENMAIC_DIR)
    parser.add_argument("--output", type=Path, default=None, help="Output directory")
    parser.add_argument("--skip-build", action="store_true", help="Reuse existing dist-offline files")
    parser.add_argument("--no-zip", action="store_true", help="Do not create a zip archive")
    return parser.parse_args()


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def build_env() -> dict[str, str]:
    env = os.environ.copy()
    runtime_dir = ROOT / ".runtime"
    env.setdefault("COREPACK_HOME", str(runtime_dir / "corepack"))
    env.setdefault("PNPM_STORE_PATH", str(runtime_dir / "pnpm-store"))
    return env


def pnpm_command() -> list[str]:
    pnpm = shutil.which("pnpm")
    if pnpm:
        return [pnpm]

    corepack = shutil.which("corepack") or "/usr/local/bin/corepack"
    if Path(corepack).exists():
        return [corepack, f"pnpm@{PNPM_VERSION}"]

    raise FileNotFoundError(
        "Neither pnpm nor corepack was found. Run deploy_openmaic.py install first, "
        "or install Node.js with Corepack."
    )


def load_classroom(openmaic_dir: Path, classroom_id: str) -> dict:
    classroom_path = openmaic_dir / "data" / "classrooms" / f"{classroom_id}.json"
    if not classroom_path.exists():
        raise FileNotFoundError(f"Classroom JSON not found: {classroom_path}")
    return json.loads(classroom_path.read_text(encoding="utf-8"))


def media_relative_path(value: str, classroom_id: str) -> str | None:
    if not isinstance(value, str):
        return None

    marker = f"/api/classroom-media/{classroom_id}/"
    if marker in value:
        tail = value.split(marker, 1)[1]
        return f"assets/{tail}"

    parsed = urlparse(value)
    if parsed.path and marker in parsed.path:
        tail = parsed.path.split(marker, 1)[1]
        return f"assets/{tail}"

    if value.startswith(f"data/classrooms/{classroom_id}/"):
        tail = value.split(f"data/classrooms/{classroom_id}/", 1)[1]
        return f"assets/{tail}"

    return None


def rewrite_assets(value, classroom_id: str):
    if isinstance(value, dict):
        next_value = {key: rewrite_assets(item, classroom_id) for key, item in value.items()}
        if isinstance(value.get("audioUrl"), str):
            rewritten = media_relative_path(value["audioUrl"], classroom_id)
            if rewritten:
                next_value["audioSrc"] = rewritten
        return next_value
    if isinstance(value, list):
        return [rewrite_assets(item, classroom_id) for item in value]
    if isinstance(value, str):
        return media_relative_path(value, classroom_id) or value
    return value


def copy_assets(openmaic_dir: Path, classroom_id: str, output_dir: Path) -> None:
    source_dir = openmaic_dir / "data" / "classrooms" / classroom_id
    assets_dir = output_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    if not source_dir.exists():
        print(f"Warning: classroom media directory does not exist: {source_dir}")
        return

    for child in source_dir.iterdir():
        if child.is_dir():
            target = assets_dir / child.name
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(child, target)
        elif child.is_file():
            shutil.copy2(child, assets_dir / child.name)


def build_offline_player(openmaic_dir: Path, skip_build: bool) -> None:
    dist_js = openmaic_dir / "dist-offline" / "offline-player.js"
    dist_css = openmaic_dir / "dist-offline" / "offline-player.css"
    if not skip_build:
        run(pnpm_command() + ["build:offline-player"], cwd=openmaic_dir, env=build_env())
        shutil.copy2(openmaic_dir / "offline-player" / "offline-player.css", dist_css)
    if not dist_js.exists():
        raise FileNotFoundError(f"Missing offline player bundle: {dist_js}")
    if not dist_css.exists():
        raise FileNotFoundError(f"Missing offline player stylesheet: {dist_css}")


def render_index(openmaic_dir: Path, classroom: dict, output_dir: Path) -> None:
    template = (openmaic_dir / "offline-player" / "index.template.html").read_text(encoding="utf-8")
    stage = classroom.get("stage") if isinstance(classroom.get("stage"), dict) else {}
    title = (
        classroom.get("name")
        or classroom.get("title")
        or stage.get("name")
        or stage.get("title")
        or "OpenMAIC Offline Classroom"
    )
    course_json = (
        json.dumps(classroom, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    index_html = template.replace("{{TITLE}}", html.escape(str(title))).replace(
        "{{COURSE_JSON}}", course_json
    )
    (output_dir / "index.html").write_text(index_html, encoding="utf-8")


def copy_player_files(openmaic_dir: Path, output_dir: Path) -> None:
    dist_dir = openmaic_dir / "dist-offline"
    for name in ("offline-player.js", "offline-player.css"):
        src = dist_dir / name
        if src.exists():
            shutil.copy2(src, output_dir / name)


def collect_asset_refs(value) -> set[str]:
    refs: set[str] = set()
    if isinstance(value, dict):
        for item in value.values():
            refs.update(collect_asset_refs(item))
    elif isinstance(value, list):
        for item in value:
            refs.update(collect_asset_refs(item))
    elif isinstance(value, str) and value.startswith("assets/"):
        refs.add(value)
    return refs


def validate_export(classroom: dict, output_dir: Path) -> None:
    index_text = (output_dir / "index.html").read_text(encoding="utf-8")
    forbidden = ["http://localhost", "/api/classroom", "/api/classroom-media", "IndexedDB"]
    found = [item for item in forbidden if item in index_text]
    if found:
        raise RuntimeError(f"Forbidden online references remain in index.html: {found}")

    missing = []
    for ref in sorted(collect_asset_refs(classroom)):
        if not (output_dir / ref).exists():
            missing.append(ref)
    if missing:
        raise RuntimeError("Missing exported assets:\n" + "\n".join(missing))


def zip_dir(output_dir: Path) -> Path:
    zip_path = output_dir.with_suffix(".zip")
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in output_dir.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(output_dir.parent))
    return zip_path


def main() -> int:
    args = parse_args()
    classroom_id = args.classroom_id
    openmaic_dir = args.openmaic_dir.resolve()
    output_dir = (args.output or DEFAULT_EXPORTS_DIR / f"{classroom_id}-offline").resolve()

    classroom = rewrite_assets(load_classroom(openmaic_dir, classroom_id), classroom_id)

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    build_offline_player(openmaic_dir, args.skip_build)
    copy_assets(openmaic_dir, classroom_id, output_dir)
    render_index(openmaic_dir, classroom, output_dir)
    copy_player_files(openmaic_dir, output_dir)
    validate_export(classroom, output_dir)

    print(f"Exported offline classroom: {output_dir}")
    if not args.no_zip:
        print(f"Created zip: {zip_dir(output_dir)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
