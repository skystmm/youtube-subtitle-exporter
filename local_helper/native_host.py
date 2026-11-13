"""Chrome Native Messaging bridge that starts the local Whisper HTTP helper."""

from __future__ import annotations

import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
from typing import BinaryIO, Callable
from urllib.error import URLError
from urllib.request import urlopen


HOST_URL = "http://127.0.0.1:43127/health"
LAUNCH_AGENT_LABEL = "com.skystmm.video-subtitle-helper"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
STARTER_PATH = PROJECT_ROOT / "start-helper.command"
LOG_PATH = Path.home() / "Library" / "Logs" / "video-subtitle-helper.log"


def read_message(stream: BinaryIO) -> dict | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("Native Messaging 消息头不完整")
    size = struct.unpack("=I", header)[0]
    payload = stream.read(size)
    if len(payload) != size:
        raise ValueError("Native Messaging 消息正文不完整")
    return json.loads(payload.decode("utf-8"))


def write_message(stream: BinaryIO, message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("=I", len(payload)))
    stream.write(payload)
    stream.flush()


def is_healthy() -> bool:
    try:
        with urlopen(HOST_URL, timeout=0.6) as response:
            return response.status == 200
    except (OSError, URLError):
        return False


def kickstart_launch_agent() -> bool:
    result = subprocess.run(
        [
            "/bin/launchctl",
            "kickstart",
            "-k",
            f"gui/{os.getuid()}/{LAUNCH_AGENT_LABEL}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def spawn_detached_server() -> None:
    if not STARTER_PATH.is_file():
        raise FileNotFoundError(f"找不到启动脚本：{STARTER_PATH}")
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("ab") as log_file:
        subprocess.Popen(
            ["/bin/zsh", str(STARTER_PATH)],
            cwd=PROJECT_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )


def ensure_server(
    *,
    health_check: Callable[[], bool] = is_healthy,
    kickstart: Callable[[], bool] = kickstart_launch_agent,
    spawn: Callable[[], None] = spawn_detached_server,
    sleep: Callable[[float], None] = time.sleep,
    attempts: int = 30,
) -> dict:
    if health_check():
        return {"ok": True, "status": "already_running"}

    if not kickstart():
        spawn()

    for _ in range(attempts):
        sleep(0.1)
        if health_check():
            return {"ok": True, "status": "started"}

    return {
        "ok": False,
        "error": f"本地助手启动超时，请查看日志：{LOG_PATH}",
    }


def handle_message(message: dict | None) -> dict:
    if not isinstance(message, dict):
        return {"ok": False, "error": "消息格式无效"}
    if message.get("action") == "status":
        return {"ok": True, "running": is_healthy()}
    if message.get("action") == "start":
        return ensure_server()
    return {"ok": False, "error": "不支持的操作"}


def main() -> None:
    try:
        response = handle_message(read_message(sys.stdin.buffer))
    except Exception as error:  # Native hosts must always return framed JSON.
        print(f"native host error: {error}", file=sys.stderr)
        response = {"ok": False, "error": str(error)}
    write_message(sys.stdout.buffer, response)


if __name__ == "__main__":
    main()
