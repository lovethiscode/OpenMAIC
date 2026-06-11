#!/usr/bin/env python3
"""Smoke-test OpenMAIC classroom generation through HTTP APIs.

This script is intentionally dependency-free. It uses only Python stdlib so it
can run on a fresh machine without installing requests/httpx.

Example:
    python3 test_openmaic_api.py
    python3 test_openmaic_api.py --base-url http://localhost:3000 --timeout 900
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


DEFAULT_BASE_URL = "http://localhost:3000"


@dataclass
class ApiResponse:
    status: int
    data: dict[str, Any]


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
) -> ApiResponse:
    body = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return ApiResponse(resp.status, json.loads(raw))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"success": False, "error": raw}
        return ApiResponse(exc.code, data)


def print_json(label: str, data: dict[str, Any]) -> None:
    print(f"\n=== {label} ===", flush=True)
    print(json.dumps(data, ensure_ascii=False, indent=2), flush=True)


def health_check(base_url: str) -> dict[str, Any]:
    resp = request_json("GET", f"{base_url}/api/health")
    print_json("Health", resp.data)
    if resp.status != 200 or not resp.data.get("success") or resp.data.get("status") != "ok":
        raise RuntimeError(f"OpenMAIC health check failed: HTTP {resp.status}")
    return resp.data


def submit_generation(base_url: str, requirement: str) -> dict[str, Any]:
    payload = {
        "requirement": requirement,
        # Enable TTS, image generation and video generation for verification
        "enableWebSearch": False,
        "enableImageGeneration": True,
        "enableVideoGeneration": True,
        "enableTTS": True,
        "agentMode": "default",
    }
    resp = request_json("POST", f"{base_url}/api/generate-classroom", payload, timeout=60)
    print_json("Submit Generation", resp.data)
    if resp.status != 202 or not resp.data.get("success"):
        raise RuntimeError(f"Generation submission failed: HTTP {resp.status}")
    return resp.data


def poll_job(
    poll_url: str,
    timeout_seconds: int,
    poll_interval_seconds: int,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_signature: tuple[Any, Any, Any, Any] | None = None

    while time.time() < deadline:
        resp = request_json("GET", poll_url, timeout=60)
        if resp.status != 200 or not resp.data.get("success"):
            print_json("Poll Error", resp.data)
            time.sleep(poll_interval_seconds)
            continue

        data = resp.data
        signature = (
            data.get("status"),
            data.get("step"),
            data.get("progress"),
            data.get("message"),
        )
        if signature != last_signature:
            print(
                "\n"
                f"[progress] status={data.get('status')} "
                f"step={data.get('step')} "
                f"progress={data.get('progress')} "
                f"scenes={data.get('scenesGenerated')}/{data.get('totalScenes')} "
                f"message={data.get('message')}",
                flush=True,
            )
            last_signature = signature

        if data.get("done"):
            print_json("Final Job", data)
            return data

        time.sleep(poll_interval_seconds)

    raise TimeoutError(f"Timed out waiting for OpenMAIC job after {timeout_seconds}s")


def fetch_classroom(base_url: str, classroom_id: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({"id": classroom_id})
    resp = request_json("GET", f"{base_url}/api/classroom?{query}", timeout=60)
    print_json("Classroom", resp.data)
    if resp.status != 200 or not resp.data.get("success"):
        raise RuntimeError(f"Classroom fetch failed: HTTP {resp.status}")
    return resp.data


def main() -> int:
    parser = argparse.ArgumentParser(description="Test OpenMAIC API classroom generation flow.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="OpenMAIC base URL")
    parser.add_argument("--timeout", type=int, default=600, help="Max seconds to wait for job")
    parser.add_argument("--poll-interval", type=int, default=10, help="Polling interval seconds")
    parser.add_argument(
        "--fetch-classroom",
        action="store_true",
        help=(
            "Fetch the local classroom after generation. This is only useful when "
            "OPENMAIC_DELETE_LOCAL_AFTER_OSS_UPLOAD is false."
        ),
    )
    parser.add_argument(
        "--requirement",
        default=(
            "生成一个非常简短的中文测试教程，主题是“健康饮水”。"
            "只需要2个小节，其中需要有一张图片， 面向普通用户，内容简洁，用于验证API生成流程。"
        ),
        help="Course generation requirement",
    )
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    try:
        health_check(base_url)
        submitted = submit_generation(base_url, args.requirement)
        poll_url = submitted.get("pollUrl")
        if not poll_url:
            job_id = submitted["jobId"]
            poll_url = f"{base_url}/api/generate-classroom/{job_id}"

        final_job = poll_job(poll_url, args.timeout, args.poll_interval)
        if final_job.get("status") != "succeeded":
            print(f"\nGeneration failed: {final_job.get('error')}", file=sys.stderr, flush=True)
            return 2

        result = final_job.get("result") or {}
        classroom_id = result.get("classroomId")
        classroom_url = result.get("url")
        zip_url = result.get("zipUrl")
        local_classroom_available = result.get("localClassroomAvailable", not zip_url)
        if not classroom_id:
            raise RuntimeError("Succeeded job did not return result.classroomId")

        if args.fetch_classroom or local_classroom_available:
            fetch_classroom(base_url, classroom_id)

        print("\n=== Success ===", flush=True)
        print(f"Classroom ID: {classroom_id}", flush=True)
        if zip_url:
            print(f"Course ZIP URL: {zip_url}", flush=True)
        if local_classroom_available or args.fetch_classroom:
            print(f"Classroom URL: {classroom_url}", flush=True)
        else:
            print(
                "Local classroom was cleaned after OSS upload; use Course ZIP URL for playback.",
                flush=True,
            )
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI smoke test should print root cause
        print(f"\nERROR: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
