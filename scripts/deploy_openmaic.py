#!/usr/bin/env python3
"""Local OpenMAIC deploy helper for FinFit integration.

This script intentionally avoids Docker and keeps toolchain/runtime state under
the open-maic workspace where possible.
"""

from __future__ import annotations

import argparse
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
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO_DIR = ROOT.parent  # 当前仓库根目录，无需 clone
RUNTIME_DIR = REPO_DIR / ".runtime"  # 运行时目录放在仓库根目录下
NODE_DIR = RUNTIME_DIR / "node"
COREPACK_HOME = RUNTIME_DIR / "corepack"
PNPM_STORE = RUNTIME_DIR / "pnpm-store"
PID_FILE = RUNTIME_DIR / "openmaic.pid"
LOG_FILE = RUNTIME_DIR / "openmaic.log"
DEPLOY_TOML_PATH = ROOT / "deploy.toml"

REPO_URL = "https://github.com/THU-MAIC/OpenMAIC.git"
OPENMAIC_TAG = "v0.2.2"
NODE_VERSION = "22.12.0"
MIN_NODE = (20, 9, 0)
PNPM_VERSION = "10.28.0"
DEFAULT_PORT = 3000


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
    deploy.setdefault("repo_url", REPO_URL)
    deploy.setdefault("tag", OPENMAIC_TAG)
    deploy.setdefault("remote_env_path", "")

    return {"server": server, "deploy": deploy}


def ensure_dirs() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    COREPACK_HOME.mkdir(parents=True, exist_ok=True)
    PNPM_STORE.mkdir(parents=True, exist_ok=True)


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


def remote_node_arch_cmd(node_version: str) -> str:
    return f"""
set -euo pipefail
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="linux-x64" ;;
  aarch64|arm64) NODE_ARCH="linux-arm64" ;;
  *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
esac
echo "node-v{node_version}-$NODE_ARCH"
"""


def remote_install_script(deploy: dict) -> str:
    remote_app_dir = deploy["remote_app_dir"]
    service_name = deploy["service_name"]
    port = int(deploy.get("port", DEFAULT_PORT))
    hostname = deploy.get("hostname", "0.0.0.0")
    repo_url = deploy.get("repo_url", REPO_URL)
    tag = deploy.get("tag", OPENMAIC_TAG)
    node_version = deploy.get("node_version", NODE_VERSION)
    pnpm_version = deploy.get("pnpm_version", PNPM_VERSION)

    return f"""
set -euo pipefail

REMOTE_APP_DIR={shell_quote(remote_app_dir)}
REPO_DIR="$REMOTE_APP_DIR/OpenMAIC"
RUNTIME_DIR="$REMOTE_APP_DIR/.runtime"
NODE_VERSION={shell_quote(node_version)}
PNPM_VERSION={shell_quote(pnpm_version)}
REPO_URL={shell_quote(repo_url)}
OPENMAIC_TAG={shell_quote(tag)}
PORT={shell_quote(port)}
HOSTNAME_VALUE={shell_quote(hostname)}
SERVICE_NAME={shell_quote(service_name)}

export DEBIAN_FRONTEND=noninteractive
mkdir -p "$REMOTE_APP_DIR" "$RUNTIME_DIR"

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y git curl ca-certificates xz-utils build-essential python3
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
  NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL"
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
mkdir -p "$COREPACK_HOME" "$PNPM_HOME" "$PNPM_STORE_PATH" "$PNPM_GLOBAL_DIR"

node -v
npm install -g "pnpm@$PNPM_VERSION" --prefix "$PNPM_GLOBAL_DIR"
pnpm --version

if [ ! -d "$REPO_DIR/.git" ]; then
  rm -rf "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
git remote set-url origin "$REPO_URL"
if [ -n "$(git status --short)" ]; then
  echo "Remote OpenMAIC worktree has local changes:" >&2
  git status --short >&2
  exit 1
fi
git fetch --tags origin
git checkout "$OPENMAIC_TAG"

if [ ! -f ".env.local" ]; then
  cp .env.example .env.local
fi
if [ -f "$REMOTE_APP_DIR/.env.local.upload" ]; then
  cp "$REMOTE_APP_DIR/.env.local.upload" ".env.local"
fi

pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_PATH"
pnpm build

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=OpenMAIC
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
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

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health"; then
    echo
    exit 0
  fi
  sleep 2
done

echo "OpenMAIC did not become healthy" >&2
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


def remote_deploy(config_path: Path = DEPLOY_TOML_PATH, upload_env: bool = False) -> None:
    config = load_remote_config(config_path)
    server = config["server"]
    deploy = config["deploy"]
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
        if upload_env:
            local_env = resolve_local_env_path(str(deploy.get("local_env_path", "")))
            remote_upload_env(ssh, sftp, deploy, local_env)
        else:
            info("Skipping env upload. Use --upload-env to sync local .env.local to remote.")

        script = remote_install_script(deploy)
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
        help="upload local env file to remote OpenMAIC/.env.local before building",
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
            remote_deploy(args.config, upload_env=args.upload_env)
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
