#!/usr/bin/env python3
"""Export an OpenMAIC classroom to a movable offline HTML package.

This script only reads and copies classroom data. It never deletes classroom
JSON, generated media, job files, or any OpenMAIC server-side data.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
OPENMAIC_DIR = ROOT / "OpenMAIC"
DEFAULT_EXPORTS_DIR = ROOT / "exports"
PNPM_VERSION = "10.28.0"
REMOTE_URL_RE = re.compile(r"https?://[^\s\"'<>]+")
CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)([^)'\"\s]+)\1\s*\)", re.IGNORECASE)
CSS_IMPORT_RE = re.compile(
    r"@import\s+(?:url\(\s*)?(['\"])([^'\"]+)\1\s*\)?",
    re.IGNORECASE,
)
KATEX_CDN_RE = re.compile(
    r"^https?://cdn\.jsdelivr\.net/npm/katex@[^/]+/dist/(?P<path>.+)$",
    re.IGNORECASE,
)
INTERACTIVE_ACTIVITY_BRIDGE = """
<script>
window.addEventListener('pointerdown', function () {
  window.parent.postMessage({ type: 'openmaic-interactive-activity' }, '*');
}, { passive: true });
</script>
""".strip()
HTML_VOID_TAGS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}


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


def is_remote_url(value: str) -> bool:
    return value.startswith(("http://", "https://"))


def is_passthrough_url(value: str) -> bool:
    return value.startswith(("data:", "blob:", "#", "javascript:", "mailto:", "tel:"))


def relative_url(from_dir: Path, target: Path) -> str:
    return posixpath.relpath(target.as_posix(), from_dir.as_posix())


class InteractiveHtmlRewriter(HTMLParser):
    def __init__(self, rewrite_url, rewrite_css):
        super().__init__(convert_charrefs=False)
        self.rewrite_url = rewrite_url
        self.rewrite_css = rewrite_css
        self.parts: list[str] = []
        self.open_tags: list[str] = []

    def handle_decl(self, decl: str) -> None:
        self.parts.append(f"<!{decl}>")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.parts.append(self._render_tag(tag, attrs, False))
        if tag.lower() not in HTML_VOID_TAGS:
            self.open_tags.append(tag.lower())

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.parts.append(self._render_tag(tag, attrs, True))

    def handle_endtag(self, tag: str) -> None:
        self.parts.append(f"</{tag}>")
        lowered = tag.lower()
        if lowered in self.open_tags:
            reverse_index = self.open_tags[::-1].index(lowered)
            del self.open_tags[len(self.open_tags) - reverse_index - 1 :]

    def handle_data(self, data: str) -> None:
        if self.open_tags and self.open_tags[-1] == "style":
            self.parts.append(self.rewrite_css(data))
        else:
            self.parts.append(data)

    def handle_entityref(self, name: str) -> None:
        self.parts.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        self.parts.append(f"&#{name};")

    def handle_comment(self, data: str) -> None:
        self.parts.append(f"<!--{data}-->")

    def handle_pi(self, data: str) -> None:
        self.parts.append(f"<?{data}>")

    def handle_unknown_decl(self, data: str) -> None:
        self.parts.append(f"<![{data}]>")

    def _render_tag(
        self, tag: str, attrs: list[tuple[str, str | None]], self_closing: bool
    ) -> str:
        rendered = [f"<{tag}"]
        for key, value in attrs:
            if value is None:
                rendered.append(f" {key}")
                continue
            lowered_key = key.lower()
            if lowered_key in {"src", "href", "poster"}:
                next_value = self.rewrite_url(value)
            elif lowered_key == "srcset":
                next_value = ", ".join(
                    " ".join(
                        [self.rewrite_url(parts[0]), *parts[1:]]
                    )
                    for candidate in value.split(",")
                    if (parts := candidate.strip().split())
                )
            elif lowered_key == "style":
                next_value = self.rewrite_css(value)
            else:
                next_value = value
            rendered.append(f' {key}="{html.escape(next_value, quote=True)}"')
        rendered.append(" />" if self_closing else ">")
        return "".join(rendered)

    def html(self) -> str:
        return "".join(self.parts)


class InteractiveAssetPackager:
    def __init__(
        self,
        openmaic_dir: Path,
        output_dir: Path,
        classroom_id: str,
        scene_dir: Path,
    ):
        self.openmaic_dir = openmaic_dir
        self.output_dir = output_dir
        self.classroom_id = classroom_id
        self.scene_dir = scene_dir
        self.remote_dir = output_dir / "assets" / "interactive" / "_vendor" / "remote"
        self.downloaded: dict[str, Path] = {}

    def rewrite_url(self, value: str) -> str:
        if not value or is_passthrough_url(value):
            return value

        katex_match = KATEX_CDN_RE.match(value)
        if katex_match:
            target = self.output_dir / "assets" / "vendor" / "katex" / katex_match.group("path")
            return relative_url(self.scene_dir, target)

        rewritten_media = media_relative_path(value, self.classroom_id)
        if rewritten_media:
            return relative_url(self.scene_dir, self.output_dir / rewritten_media)

        if value.startswith("assets/"):
            return relative_url(self.scene_dir, self.output_dir / value)

        if is_remote_url(value):
            return relative_url(self.scene_dir, self.download_remote(value))

        return value

    def rewrite_inline_css(self, css: str) -> str:
        css = CSS_URL_RE.sub(
            lambda match: f"url('{self.rewrite_url(match.group(2))}')",
            css,
        )
        return CSS_IMPORT_RE.sub(
            lambda match: f"@import '{self.rewrite_url(match.group(2))}'",
            css,
        )

    def download_remote(self, url: str) -> Path:
        if url in self.downloaded:
            return self.downloaded[url]

        parsed = urlparse(url)
        name = Path(parsed.path).name or "asset"
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
        target_dir = self.remote_dir / digest
        target = target_dir / name
        target_dir.mkdir(parents=True, exist_ok=True)

        print(f"Downloading interactive dependency: {url}")
        request = Request(url, headers={"User-Agent": "OpenMAIC offline exporter"})
        with urlopen(request, timeout=30) as response:
            content = response.read()
            content_type = response.headers.get_content_type()

        self.downloaded[url] = target
        if content_type == "text/css" or target.suffix.lower() == ".css":
            css = content.decode("utf-8")
            css = CSS_URL_RE.sub(
                lambda match: self._rewrite_css_url(match, url, target_dir),
                css,
            )
            css = CSS_IMPORT_RE.sub(
                lambda match: self._rewrite_css_import(match, url, target_dir),
                css,
            )
            target.write_text(css, encoding="utf-8")
        else:
            target.write_bytes(content)
        return target

    def _rewrite_css_url(self, match: re.Match[str], stylesheet_url: str, target_dir: Path) -> str:
        value = match.group(2)
        if is_passthrough_url(value):
            return match.group(0)
        dependency_url = urljoin(stylesheet_url, value)
        dependency = self.download_remote(dependency_url)
        return f"url('{relative_url(target_dir, dependency)}')"

    def _rewrite_css_import(
        self, match: re.Match[str], stylesheet_url: str, target_dir: Path
    ) -> str:
        dependency_url = urljoin(stylesheet_url, match.group(2))
        dependency = self.download_remote(dependency_url)
        return f"@import '{relative_url(target_dir, dependency)}'"


def copy_interactive_vendor_assets(openmaic_dir: Path, output_dir: Path, classroom: dict) -> None:
    interactive_html = [
        scene.get("content", {}).get("html", "")
        for scene in classroom.get("scenes", [])
        if scene.get("content", {}).get("type") == "interactive"
    ]
    if not any(
        KATEX_CDN_RE.match(url)
        for source in interactive_html
        for url in REMOTE_URL_RE.findall(source)
    ):
        return

    katex_source = openmaic_dir / "node_modules" / "katex" / "dist"
    if not katex_source.exists():
        raise FileNotFoundError(f"KaTeX distribution not found: {katex_source}")
    katex_target = output_dir / "assets" / "vendor" / "katex"
    shutil.copytree(katex_source, katex_target, dirs_exist_ok=True)


def package_interactive_scenes(
    openmaic_dir: Path, classroom: dict, classroom_id: str, output_dir: Path
) -> None:
    copy_interactive_vendor_assets(openmaic_dir, output_dir, classroom)

    for scene in classroom.get("scenes", []):
        content = scene.get("content")
        if not isinstance(content, dict) or content.get("type") != "interactive":
            continue

        source_html = content.get("html")
        if not isinstance(source_html, str) or not source_html.strip():
            raise RuntimeError(f"Interactive scene has no embedded HTML: {scene.get('id')}")

        scene_id = str(scene.get("id") or "interactive")
        scene_dir = output_dir / "assets" / "interactive" / scene_id
        scene_dir.mkdir(parents=True, exist_ok=True)
        packager = InteractiveAssetPackager(
            openmaic_dir,
            output_dir,
            classroom_id,
            scene_dir,
        )
        parser = InteractiveHtmlRewriter(packager.rewrite_url, packager.rewrite_inline_css)
        parser.feed(source_html)
        parser.close()
        packaged_html = parser.html()
        body_end = packaged_html.lower().rfind("</body>")
        if body_end >= 0:
            packaged_html = (
                packaged_html[:body_end]
                + INTERACTIVE_ACTIVITY_BRIDGE
                + packaged_html[body_end:]
            )
        else:
            packaged_html += INTERACTIVE_ACTIVITY_BRIDGE
        remaining_remote = sorted(set(REMOTE_URL_RE.findall(packaged_html)))
        if remaining_remote:
            raise RuntimeError(
                f"Interactive scene still contains remote URLs ({scene_id}):\n"
                + "\n".join(remaining_remote)
            )

        (scene_dir / "index.html").write_text(packaged_html, encoding="utf-8")
        content["offlineSrc"] = f"assets/interactive/{scene_id}/index.html"
        content.pop("html", None)
        content["url"] = ""


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
    index_html = template.replace("{{TITLE}}", html.escape(str(title)))
    (output_dir / "index.html").write_text(index_html, encoding="utf-8")


def js_assignment(target: str, value) -> str:
    payload = (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    return f"{target} = {payload};\n"


def write_offline_data_files(classroom: dict, output_dir: Path) -> dict:
    scenes_dir = output_dir / "scenes"
    scenes_dir.mkdir(parents=True, exist_ok=True)
    manifest_scenes = []

    for scene in sorted(classroom.get("scenes", []), key=lambda item: item.get("order", 0)):
        scene_id = str(scene.get("id"))
        json_src = f"scenes/{scene_id}.json"
        js_src = f"scenes/{scene_id}.js"
        (output_dir / json_src).write_text(
            json.dumps(scene, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        (output_dir / js_src).write_text(
            "window.OPENMAIC_OFFLINE_SCENES = window.OPENMAIC_OFFLINE_SCENES || {};\n"
            + js_assignment(f"window.OPENMAIC_OFFLINE_SCENES[{json.dumps(scene_id)}]", scene),
            encoding="utf-8",
        )
        manifest_scenes.append(
            {
                "id": scene_id,
                "title": scene.get("title", ""),
                "type": scene.get("type", ""),
                "order": scene.get("order", 0),
                "src": js_src,
                "jsonSrc": json_src,
            }
        )

    stage = classroom.get("stage") if isinstance(classroom.get("stage"), dict) else {}
    manifest = {
        "id": classroom.get("id"),
        "title": stage.get("name") or stage.get("title") or "OpenMAIC Offline Classroom",
        "stage": stage,
        "scenes": manifest_scenes,
        "createdAt": classroom.get("createdAt"),
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (output_dir / "manifest.js").write_text(
        js_assignment("window.OPENMAIC_OFFLINE_MANIFEST", manifest),
        encoding="utf-8",
    )
    return manifest


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
    if "openmaic-course-data" in index_text or "{{COURSE_JSON}}" in index_text:
        raise RuntimeError("index.html must not contain inline course data")

    manifest_path = output_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("id") != classroom.get("id"):
        raise RuntimeError("manifest.json does not match the exported classroom")
    if len(manifest.get("scenes", [])) != len(classroom.get("scenes", [])):
        raise RuntimeError("manifest.json scene count does not match the exported classroom")

    for scene_entry in manifest.get("scenes", []):
        scene_path = output_dir / scene_entry["jsonSrc"]
        scene = json.loads(scene_path.read_text(encoding="utf-8"))
        if scene.get("id") != scene_entry.get("id"):
            raise RuntimeError(f"Scene JSON id mismatch: {scene_entry.get('id')}")
        content = scene.get("content")
        if not isinstance(content, dict) or content.get("type") != "interactive":
            continue
        if isinstance(content.get("html"), str):
            raise RuntimeError(f"Interactive scene still contains embedded HTML: {scene.get('id')}")
        offline_src = content.get("offlineSrc")
        if not isinstance(offline_src, str) or not (output_dir / offline_src).exists():
            raise RuntimeError(f"Missing packaged interactive scene: {scene.get('id')}")
        interactive_html = (output_dir / offline_src).read_text(encoding="utf-8")
        remote_urls = sorted(set(REMOTE_URL_RE.findall(interactive_html)))
        if remote_urls:
            raise RuntimeError(
                f"Remote URLs remain in interactive scene {scene.get('id')}:\n"
                + "\n".join(remote_urls)
            )

    forbidden = ["http://localhost", "/api/classroom", "/api/classroom-media", "IndexedDB"]
    exported_text = collect_exported_text(output_dir)
    found = [item for item in forbidden if item in exported_text]
    if found:
        raise RuntimeError(f"Forbidden online references remain in offline export: {found}")

    missing = []
    for ref in sorted(collect_asset_refs(classroom)):
        if not (output_dir / ref).exists():
            missing.append(ref)
    if missing:
        raise RuntimeError("Missing exported assets:\n" + "\n".join(missing))


def collect_exported_text(output_dir: Path) -> str:
    chunks: list[str] = []
    for path in output_dir.rglob("*"):
        if not path.is_file():
            continue
        if path.name in {"offline-player.js", "offline-player.css"}:
            continue
        if path.suffix.lower() in {".html", ".json", ".js", ".css"}:
            chunks.append(path.read_text(encoding="utf-8"))
    return "\n".join(chunks)


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
    package_interactive_scenes(openmaic_dir, classroom, classroom_id, output_dir)
    write_offline_data_files(classroom, output_dir)
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
