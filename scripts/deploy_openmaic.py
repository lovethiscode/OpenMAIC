#!/usr/bin/env python3
"""Local OpenMAIC deploy helper for FinFit integration.

This script intentionally avoids Docker and keeps toolchain/runtime state under
the open-maic workspace where possible.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import tomllib
import urllib.request
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO_DIR = ROOT.parent  # 当前仓库根目录，无需 clone
RUNTIME_DIR = REPO_DIR / ".runtime"  # 运行时目录放在仓库根目录下
NODE_DIR = RUNTIME_DIR / "node"
COREPACK_HOME = RUNTIME_DIR / "corepack"
PNPM_STORE = RUNTIME_DIR / "pnpm-store"
PID_FILE = RUNTIME_DIR / "openmaic.pid"
LOG_FILE = RUNTIME_DIR / "openmaic.log"
DEPLOY_ARCHIVE_DIR = RUNTIME_DIR / "deploy"
DEPLOY_TOML_PATH = ROOT / "deploy.toml"

REPO_URL = "https://github.com/THU-MAIC/OpenMAIC.git"
OPENMAIC_TAG = "v0.2.2"
NODE_VERSION = "22.12.0"
MIN_NODE = (20, 9, 0)
PNPM_VERSION = "10.28.0"
DEFAULT_PORT = 3000
DEFAULT_RELEASE_KEEP = 3
DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com"
DEFAULT_NODE_MIRROR = "https://npmmirror.com/mirrors/node"
DEFAULT_BINARY_MIRROR = "https://npmmirror.com/mirrors"
DEPLOY_ARCHIVE_EXCLUDES = {
    "scripts/deploy.toml",
}


class DeployError(RuntimeError):
    pass


def info(message: str) -> None:
    print(f"[open-maic] {message}", flush=True)


def run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    info("$ " + " ".join(cmd))
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        check=check,
    )


def parse_node_version(raw: str) -> tuple[int, int, int] | None:
    raw = raw.strip().lstrip("v")
    parts = raw.split(".")
    if len(parts) < 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), int(parts[2].split("-")[0])
    except ValueError:
        return None


def command_output(cmd: list[str], env: dict[str, str] | None = None) -> str | None:
    try:
        result = subprocess.run(
            cmd,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=True,
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None


def load_remote_config(config_path: Path = DEPLOY_TOML_PATH) -> dict:
    if not config_path.exists():
        raise DeployError(f"deploy config not found: {config_path}")

    with config_path.open("rb") as f:
        config = tomllib.load(f)

    server = config.get("server", {})
    deploy = config.get("deploy", {})
    for key in ["host", "username"]:
        if not str(server.get(key, "")).strip():
            raise DeployError(f"deploy.toml missing [server].{key}")

    has_key = bool(str(server.get("key_path", "")).strip())
    has_password = bool(str(server.get("password", "")).strip())
    if not has_key and not has_password:
        raise DeployError("deploy.toml [server] must set either key_path or password")

    if has_key:
        server["key_path"] = str(Path(server["key_path"]).expanduser())
    else:
        server["key_path"] = ""

    deploy.setdefault("remote_app_dir", "/usr/local/openmaic")
    deploy.setdefault("service_name", "openmaic")
    deploy.setdefault("port", DEFAULT_PORT)
    deploy.setdefault("hostname", "0.0.0.0")
    deploy.setdefault("node_version", NODE_VERSION)
    deploy.setdefault("pnpm_version", PNPM_VERSION)
    deploy.setdefault("npm_registry", DEFAULT_NPM_REGISTRY)
    deploy.setdefault("node_mirror", DEFAULT_NODE_MIRROR)
    deploy.setdefault("binary_mirror", DEFAULT_BINARY_MIRROR)
    deploy.setdefault("remote_releases_dir", f"{deploy['remote_app_dir']}/releases")
    deploy.setdefault("release_keep", DEFAULT_RELEASE_KEEP)
    if int(deploy["release_keep"]) < 1:
        raise DeployError("deploy.toml [deploy].release_keep must be at least 1")

    return {"server": server, "deploy": deploy}


def ensure_dirs() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    COREPACK_HOME.mkdir(parents=True, exist_ok=True)
    PNPM_STORE.mkdir(parents=True, exist_ok=True)
    DEPLOY_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)


def system_node_is_usable() -> bool:
    out = command_output(["node", "-v"])
    if not out:
        return False
    version = parse_node_version(out)
    return bool(version and version >= MIN_NODE)


def local_node_bin() -> Path:
    return NODE_DIR / "bin" / "node"


def local_corepack_bin() -> Path:
    return NODE_DIR / "bin" / "corepack"


def node_bin_dir() -> Path | None:
    if local_node_bin().exists():
        return NODE_DIR / "bin"
    if system_node_is_usable():
        node_path = shutil.which("node")
        if node_path:
            return Path(node_path).resolve().parent
    return None


def download_node() -> None:
    if platform.system() != "Darwin":
        raise DeployError("Automatic Node download currently supports macOS only.")

    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        arch = "darwin-arm64"
    elif machine in {"x86_64", "amd64"}:
        arch = "darwin-x64"
    else:
        raise DeployError(f"Unsupported macOS architecture: {platform.machine()}")

    archive_name = f"node-v{NODE_VERSION}-{arch}.tar.gz"
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/{archive_name}"
    archive_path = RUNTIME_DIR / archive_name
    extract_root = RUNTIME_DIR / f"node-v{NODE_VERSION}-{arch}"

    if local_node_bin().exists():
        return

    info(f"Downloading Node.js {NODE_VERSION} for {arch}")
    urllib.request.urlretrieve(url, archive_path)

    if extract_root.exists():
        shutil.rmtree(extract_root)
    with tarfile.open(archive_path, "r:gz") as tf:
        tf.extractall(RUNTIME_DIR)

    if NODE_DIR.exists():
        shutil.rmtree(NODE_DIR)
    extract_root.rename(NODE_DIR)
    archive_path.unlink(missing_ok=True)


def ensure_node() -> Path:
    ensure_dirs()
    existing = node_bin_dir()
    if existing:
        out = command_output([str(existing / "node"), "-v"]) or "unknown"
        info(f"Using Node.js {out} from {existing}")
        return existing

    download_node()
    out = command_output([str(local_node_bin()), "-v"]) or "unknown"
    version = parse_node_version(out)
    if not version or version < MIN_NODE:
        raise DeployError(f"Downloaded Node is not usable: {out}")
    info(f"Using downloaded Node.js {out}")
    return NODE_DIR / "bin"


def base_env() -> dict[str, str]:
    node_dir = ensure_node()
    env = os.environ.copy()
    env["PATH"] = f"{node_dir}{os.pathsep}{env.get('PATH', '')}"
    env["COREPACK_HOME"] = str(COREPACK_HOME)
    env["PNPM_HOME"] = str(RUNTIME_DIR / "pnpm-home")
    env["PNPM_STORE_PATH"] = str(PNPM_STORE)
    return env


def corepack_cmd() -> list[str]:
    corepack = shutil.which("corepack", path=base_env()["PATH"])
    if not corepack:
        raise DeployError("corepack was not found in the selected Node.js runtime.")
    return [corepack]


def pnpm_cmd() -> list[str]:
    return corepack_cmd() + [f"pnpm@{PNPM_VERSION}"]


def ensure_pnpm() -> None:
    env = base_env()
    result = run(pnpm_cmd() + ["--version"], env=env, capture=True)
    version = (result.stdout or "").strip()
    if version != PNPM_VERSION:
        raise DeployError(f"Expected pnpm {PNPM_VERSION}, got {version}")
    info(f"Using pnpm {version}")


def ensure_repo() -> None:
    if not (REPO_DIR / ".git").exists():
        raise DeployError(f"{REPO_DIR} is not a git repository.")

    remote = run(["git", "remote", "get-url", "origin"], cwd=REPO_DIR, capture=True).stdout.strip()
    if remote not in {REPO_URL, REPO_URL.replace("https://", "git@").replace("/", ":", 1)}:
        info(f"Warning: origin is {remote}, expected {REPO_URL}")

    # 本地开发不切换分支，直接使用当前代码
    info(f"Using current branch at {REPO_DIR}")
    branch = run(["git", "branch", "--show-current"], cwd=REPO_DIR, capture=True).stdout.strip()
    info(f"Current branch: {branch}")


def ensure_env_file() -> None:
    target = REPO_DIR / ".env.local"
    if target.exists():
        info(f"Keeping existing {target}")
        return

    source = REPO_DIR / ".env.example"
    if not source.exists():
        raise DeployError(f".env.example not found: {source}")
    shutil.copyfile(source, target)
    info(f"Created {target} from {source}")


def install() -> None:
    ensure_dirs()
    ensure_node()
    ensure_pnpm()
    ensure_repo()
    ensure_env_file()
    env = base_env()
    env["CI"] = "true"
    run(
        pnpm_cmd() + ["install", "--frozen-lockfile", "--store-dir", str(PNPM_STORE)],
        cwd=REPO_DIR,
        env=env,
    )
    info("Install complete.")


def read_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text().strip())
    except ValueError:
        return None


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def health_url(port: int = DEFAULT_PORT) -> str:
    return f"http://localhost:{port}/api/health"


def check_health(port: int = DEFAULT_PORT, *, timeout_s: int = 5) -> tuple[bool, str]:
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health_url(port), timeout=3) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                data = json.loads(body)
                if data.get("success") and data.get("status") == "ok":
                    return True, body
                last = body
        except Exception as exc:  # noqa: BLE001 - best-effort health check
            last = str(exc)
        time.sleep(1)
    return False, last


def start(port: int = DEFAULT_PORT) -> None:
    ensure_node()
    ensure_pnpm()
    if not REPO_DIR.exists():
        raise DeployError("OpenMAIC is not installed yet. Run `install` first.")
    ensure_env_file()

    existing = read_pid()
    if existing and process_alive(existing):
        info(f"OpenMAIC already appears to be running with PID {existing}")
        ok, body = check_health(port, timeout_s=5)
        if ok:
            info(f"Health OK: {body}")
        return

    ok, body = check_health(port, timeout_s=2)
    if ok:
        info(f"Something is already serving OpenMAIC health on port {port}: {body}")
        return

    env = base_env()
    env["PORT"] = str(port)
    env.setdefault("HOSTNAME", "0.0.0.0")

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    log_handle = LOG_FILE.open("ab")
    proc = subprocess.Popen(
        pnpm_cmd() + ["dev"],
        cwd=str(REPO_DIR),
        env=env,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    PID_FILE.write_text(str(proc.pid))
    info(f"Started OpenMAIC dev server with PID {proc.pid}")
    info(f"Logs: {LOG_FILE}")

    ok, body = check_health(port, timeout_s=90)
    if not ok:
        raise DeployError(f"OpenMAIC did not become healthy. Last error: {body}")
    info(f"Health OK: {body}")


def stop() -> None:
    pid = read_pid()
    if not pid:
        info("No PID file found.")
        return
    if not process_alive(pid):
        info(f"PID {pid} is not running.")
        PID_FILE.unlink(missing_ok=True)
        return
    os.killpg(pid, signal.SIGTERM)
    for _ in range(20):
        if not process_alive(pid):
            PID_FILE.unlink(missing_ok=True)
            info(f"Stopped PID {pid}")
            return
        time.sleep(0.5)
    os.killpg(pid, signal.SIGKILL)
    PID_FILE.unlink(missing_ok=True)
    info(f"Force-stopped PID {pid}")


def status(port: int = DEFAULT_PORT) -> None:
    pid = read_pid()
    if pid and process_alive(pid):
        info(f"PID {pid} is running.")
    else:
        info("No managed OpenMAIC process is running.")
    ok, body = check_health(port, timeout_s=5)
    if ok:
        info(f"Health OK: {body}")
    else:
        info(f"Health failed: {body}")


def health(port: int = DEFAULT_PORT) -> None:
    ok, body = check_health(port, timeout_s=10)
    if not ok:
        raise DeployError(f"Health failed: {body}")
    print(body)


def tracked_release_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=str(REPO_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    files = [os.fsdecode(item) for item in result.stdout.split(b"\0") if item]
    release_files: list[str] = []
    for relative_path in files:
        normalized = relative_path.replace(os.sep, "/")
        name = Path(normalized).name
        if normalized in DEPLOY_ARCHIVE_EXCLUDES:
            continue
        if name.startswith(".env") and normalized != ".env.example":
            continue
        source = REPO_DIR / relative_path
        if source.exists() or source.is_symlink():
            release_files.append(normalized)
    if not release_files:
        raise DeployError("No tracked source files were found for the release archive.")
    return release_files


def normalize_release_tarinfo(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo:
    tarinfo.uid = 0
    tarinfo.gid = 0
    tarinfo.uname = "root"
    tarinfo.gname = "root"
    return tarinfo


def create_release_archive() -> tuple[Path, str, str]:
    ensure_dirs()
    release_files = tracked_release_files()
    timestamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S%f")
    revision = command_output(["git", "-C", str(REPO_DIR), "rev-parse", "--short", "HEAD"]) or "nogit"
    release_id = f"{timestamp}-{revision}"
    archive_path = DEPLOY_ARCHIVE_DIR / f"openmaic-{release_id}.tar.gz"

    info(f"Creating source release archive with {len(release_files)} tracked files")
    with tarfile.open(archive_path, "w:gz") as archive:
        for relative_path in release_files:
            archive.add(
                REPO_DIR / relative_path,
                arcname=relative_path,
                recursive=False,
                filter=normalize_release_tarinfo,
            )

    digest_hash = hashlib.sha256()
    with archive_path.open("rb") as archive_file:
        for chunk in iter(lambda: archive_file.read(1024 * 1024), b""):
            digest_hash.update(chunk)
    digest = digest_hash.hexdigest()
    info(f"Release archive: {archive_path}")
    info(f"SHA-256: {digest}")
    return archive_path, release_id, digest


def validate_local_build() -> None:
    ensure_node()
    ensure_pnpm()
    env = base_env()
    env["NODE_ENV"] = "production"
    run(pnpm_cmd() + ["build"], cwd=REPO_DIR, env=env)
    info("Local production build validation complete.")


def require_paramiko():
    try:
        import paramiko  # type: ignore
    except ImportError as exc:
        raise DeployError("Missing dependency: paramiko. Install with `python3 -m pip install paramiko`.") from exc
    return paramiko


def ssh_connect(server: dict):
    paramiko = require_paramiko()
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs = {
        "hostname": server["host"],
        "port": int(server.get("port", 22)),
        "username": server["username"],
        "timeout": 60,  # 增加超时时间到 60 秒
        "banner_timeout": 60,  # SSH banner 超时时间
        "auth_timeout": 60,  # 认证超时时间
    }
    if server.get("key_path"):
        kwargs["key_filename"] = server["key_path"]
    else:
        kwargs["password"] = server["password"]
    ssh.connect(**kwargs)
    return ssh


def remote_exec(
    ssh,
    cmd: str,
    description: str = "",
    *,
    check: bool = True,
    input_data: str | None = None,
) -> int:
    if description:
        info(description)
    info("remote$ " + cmd)
    stdin, stdout, stderr = ssh.exec_command(cmd)
    if input_data is not None:
        stdin.write(input_data)
        stdin.channel.shutdown_write()
    for line in iter(stdout.readline, ""):
        print(f"  {line.rstrip()}")
    exit_status = stdout.channel.recv_exit_status()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if err:
        for line in err.splitlines():
            print(f"  {line}")
    if check and exit_status != 0:
        raise DeployError(f"remote command failed ({exit_status}): {cmd}")
    return exit_status


def shell_quote(value: str | int) -> str:
    return shlex.quote(str(value))


def remote_install_script(
    deploy: dict,
    release_id: str,
    remote_archive_path: str,
    archive_sha256: str,
) -> str:
    remote_app_dir = deploy["remote_app_dir"]
    remote_releases_dir = deploy["remote_releases_dir"]
    service_name = deploy["service_name"]
    port = int(deploy.get("port", DEFAULT_PORT))
    hostname = deploy.get("hostname", "0.0.0.0")
    node_version = deploy.get("node_version", NODE_VERSION)
    pnpm_version = deploy.get("pnpm_version", PNPM_VERSION)
    npm_registry = str(deploy.get("npm_registry", DEFAULT_NPM_REGISTRY)).rstrip("/")
    node_mirror = str(deploy.get("node_mirror", DEFAULT_NODE_MIRROR)).rstrip("/")
    binary_mirror = str(deploy.get("binary_mirror", DEFAULT_BINARY_MIRROR)).rstrip("/")
    release_keep = int(deploy.get("release_keep", DEFAULT_RELEASE_KEEP))

    return f"""
set -euo pipefail

REMOTE_APP_DIR={shell_quote(remote_app_dir)}
RELEASES_DIR={shell_quote(remote_releases_dir)}
RELEASE_ID={shell_quote(release_id)}
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CURRENT_LINK="$REMOTE_APP_DIR/current"
ARCHIVE_PATH={shell_quote(remote_archive_path)}
ARCHIVE_SHA256={shell_quote(archive_sha256)}
RUNTIME_DIR="$REMOTE_APP_DIR/.runtime"
NODE_VERSION={shell_quote(node_version)}
PNPM_VERSION={shell_quote(pnpm_version)}
NPM_REGISTRY={shell_quote(npm_registry)}
NODE_MIRROR={shell_quote(node_mirror)}
BINARY_MIRROR={shell_quote(binary_mirror)}
RELEASE_KEEP={shell_quote(release_keep)}
PORT={shell_quote(port)}
HOSTNAME_VALUE={shell_quote(hostname)}
SERVICE_NAME={shell_quote(service_name)}

export DEBIAN_FRONTEND=noninteractive
mkdir -p "$REMOTE_APP_DIR" "$RELEASES_DIR" "$RUNTIME_DIR"

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl ca-certificates xz-utils build-essential python3
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="linux-x64" ;;
  aarch64|arm64) NODE_ARCH="linux-arm64" ;;
  *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
esac

NODE_DIR="$RUNTIME_DIR/node"
NODE_BIN="$NODE_DIR/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_TARBALL="node-v$NODE_VERSION-$NODE_ARCH.tar.xz"
  NODE_URL="$NODE_MIRROR/v$NODE_VERSION/$NODE_TARBALL"
  TMP_TARBALL="/tmp/$NODE_TARBALL"
  echo "Downloading $NODE_URL"
  curl -fsSL "$NODE_URL" -o "$TMP_TARBALL"
  rm -rf "$NODE_DIR" "$RUNTIME_DIR/node-v$NODE_VERSION-$NODE_ARCH"
  tar -xJf "$TMP_TARBALL" -C "$RUNTIME_DIR"
  mv "$RUNTIME_DIR/node-v$NODE_VERSION-$NODE_ARCH" "$NODE_DIR"
  rm -f "$TMP_TARBALL"
fi

PNPM_GLOBAL_DIR="$RUNTIME_DIR/pnpm-global"
export PATH="$PNPM_GLOBAL_DIR/bin:$NODE_DIR/bin:$PATH"
export COREPACK_HOME="$RUNTIME_DIR/corepack"
export PNPM_HOME="$RUNTIME_DIR/pnpm-home"
export PNPM_STORE_PATH="$RUNTIME_DIR/pnpm-store"
export npm_config_registry="$NPM_REGISTRY"
export npm_config_disturl="$NODE_MIRROR"
export npm_config_nodejs_org_mirror="$NODE_MIRROR"
export npm_config_sharp_binary_host="$BINARY_MIRROR/sharp"
export npm_config_sharp_libvips_binary_host="$BINARY_MIRROR/sharp-libvips"
export npm_config_canvas_binary_host="$BINARY_MIRROR/node-canvas-prebuilt"
export SHARP_DIST_BASE_URL="$BINARY_MIRROR/sharp-libvips"
mkdir -p "$COREPACK_HOME" "$PNPM_HOME" "$PNPM_STORE_PATH" "$PNPM_GLOBAL_DIR"

node -v
npm install -g "pnpm@$PNPM_VERSION" --prefix "$PNPM_GLOBAL_DIR" --registry "$NPM_REGISTRY"
pnpm --version
pnpm config set registry "$NPM_REGISTRY"

echo "$ARCHIVE_SHA256  $ARCHIVE_PATH" | sha256sum --check -
if [ -e "$RELEASE_DIR" ]; then
  echo "Release directory already exists: $RELEASE_DIR" >&2
  exit 1
fi
mkdir -p "$RELEASE_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_DIR"

if [ -f "$REMOTE_APP_DIR/.env.local.upload" ]; then
  cp "$REMOTE_APP_DIR/.env.local.upload" "$RELEASE_DIR/.env.local"
elif [ -f "$CURRENT_LINK/.env.local" ]; then
  cp "$CURRENT_LINK/.env.local" "$RELEASE_DIR/.env.local"
elif [ -f "$RELEASE_DIR/.env.example" ]; then
  cp "$RELEASE_DIR/.env.example" "$RELEASE_DIR/.env.local"
fi

cd "$RELEASE_DIR"
pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_PATH" --registry "$NPM_REGISTRY"
pnpm build

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=OpenMAIC
After=network.target

[Service]
Type=simple
WorkingDirectory=$CURRENT_LINK
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOSTNAME=$HOSTNAME_VALUE
Environment=COREPACK_HOME=$COREPACK_HOME
Environment=PNPM_HOME=$PNPM_HOME
Environment=PNPM_STORE_PATH=$PNPM_STORE_PATH
Environment=PATH=$PNPM_GLOBAL_DIR/bin:$NODE_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$PNPM_GLOBAL_DIR/bin/pnpm start
Restart=always
RestartSec=5
StandardOutput=append:$RUNTIME_DIR/openmaic.log
StandardError=append:$RUNTIME_DIR/openmaic.log

[Install]
WantedBy=multi-user.target
EOF

PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

for i in $(seq 1 60); do
  echo "Health check attempt $i/60: http://127.0.0.1:$PORT/api/health"
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "OpenMAIC is healthy after attempt $i/60."
    rm -f "$ARCHIVE_PATH"
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\\n' \
      | sort -rn \
      | awk -v keep="$RELEASE_KEEP" 'NR > keep {{sub(/^[^ ]+ /, ""); print}}' \
      | while IFS= read -r old_release; do
          [ "$(readlink -f "$CURRENT_LINK")" = "$old_release" ] || rm -rf "$old_release"
        done
    exit 0
  fi
  echo "OpenMAIC is not ready yet; retrying in 2 seconds."
  sleep 2
done

echo "OpenMAIC did not become healthy after 60 attempts." >&2
if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
  echo "Rolling back to $PREVIOUS_RELEASE" >&2
  ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
  systemctl restart "$SERVICE_NAME" || true
else
  rm -f "$CURRENT_LINK"
  systemctl stop "$SERVICE_NAME" || true
fi
systemctl status "$SERVICE_NAME" --no-pager || true
journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
exit 1
"""


def resolve_local_env_path(path_value: str) -> Path | None:
    candidates: list[Path] = []
    if path_value:
        candidates.append(Path(path_value).expanduser())
    candidates.extend([REPO_DIR / ".env.local", REPO_DIR / ".env", REPO_DIR / ".env.example"])
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def remote_upload_env(ssh, sftp, deploy: dict, local_env_path: Path | None) -> None:
    if not local_env_path:
        info("No local env file found to upload; remote will keep/create its own .env.local")
        return
    remote_app_dir = deploy["remote_app_dir"]
    staging_env_path = f"{remote_app_dir}/.env.local.upload"
    remote_exec(ssh, f"mkdir -p {shell_quote(remote_app_dir)}", "Prepare remote env staging dir")
    info(f"Uploading env: {local_env_path} -> {staging_env_path}")
    sftp.put(str(local_env_path), staging_env_path)


def remote_deploy(
    config_path: Path = DEPLOY_TOML_PATH,
    upload_env: bool = False,
    skip_local_build: bool = False,
) -> None:
    config = load_remote_config(config_path)
    server = config["server"]
    deploy = config["deploy"]
    if not skip_local_build:
        validate_local_build()
    else:
        info("Skipping local production build validation.")
    archive_path, release_id, archive_sha256 = create_release_archive()
    remote_upload_dir = f"{deploy['remote_app_dir']}/uploads"
    remote_archive_path = f"{remote_upload_dir}/{archive_path.name}"
    info(
        f"Remote target: {server['username']}@{server['host']}:{server.get('port', 22)} "
        f"-> {deploy['remote_app_dir']}"
    )

    ssh = ssh_connect(server)
    sftp = None
    try:
        sftp = ssh.open_sftp()
        remote_exec(
            ssh,
            "uname -a && (command -v lsb_release >/dev/null 2>&1 && lsb_release -a || true)",
            "Remote system info",
        )
        remote_exec(
            ssh,
            f"mkdir -p {shell_quote(remote_upload_dir)}",
            "Prepare remote release upload dir",
        )
        info(f"Uploading release: {archive_path} -> {remote_archive_path}")
        sftp.put(str(archive_path), remote_archive_path)
        if upload_env:
            local_env = resolve_local_env_path(str(deploy.get("local_env_path", "")))
            remote_upload_env(ssh, sftp, deploy, local_env)
        else:
            info("Skipping env upload. Use --upload-env to sync local .env.local to remote.")

        script = remote_install_script(deploy, release_id, remote_archive_path, archive_sha256)
        remote_exec(ssh, "bash -s", "Remote install/build/restart", input_data=script)
    finally:
        if sftp:
            sftp.close()
        ssh.close()

def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy and run local OpenMAIC.")
    parser.add_argument(
        "command",
        choices=["install", "start", "stop", "status", "health", "remote-deploy"],
        help="command",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--config",
        type=Path,
        default=DEPLOY_TOML_PATH,
        help=f"remote deploy config path (default: {DEPLOY_TOML_PATH})",
    )
    parser.add_argument(
        "--upload-env",
        action="store_true",
        help="upload the configured local env file into the new remote release",
    )
    parser.add_argument(
        "--skip-local-build",
        action="store_true",
        help="skip local pnpm build validation before creating the source archive",
    )
    args = parser.parse_args()

    try:
        if args.command == "install":
            install()
        elif args.command == "start":
            start(args.port)
        elif args.command == "stop":
            stop()
        elif args.command == "status":
            status(args.port)
        elif args.command == "health":
            health(args.port)
        elif args.command == "remote-deploy":
            remote_deploy(
                args.config,
                upload_env=args.upload_env,
                skip_local_build=args.skip_local_build,
            )
        return 0
    except subprocess.CalledProcessError as exc:
        if exc.stdout:
            print(exc.stdout, file=sys.stderr)
        print(f"Command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        return exc.returncode or 1
    except DeployError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
