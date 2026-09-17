#!/usr/bin/env python3
from __future__ import annotations

import atexit
import json
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 43127
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ACCURATE_MODEL = "mlx-community/whisper-large-v3-mlx"
TRANSCRIPTION_MODES = {"fast", "accurate"}
SUPPORTED_LANGUAGES = {
    "auto", "zh", "en", "ja", "ko", "es", "fr", "de", "ru", "pt", "it", "ar", "hi", "vi"
}


def validate_youtube_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in YOUTUBE_HOSTS:
        raise ValueError("只支持 HTTPS YouTube 视频地址")
    if parsed.hostname == "youtu.be":
        if not parsed.path.strip("/"):
            raise ValueError("YouTube 视频地址缺少视频 ID")
    elif parsed.path != "/watch" or not parse_qs(parsed.query).get("v", [""])[0]:
        raise ValueError("YouTube 视频地址格式不正确")
    return value


def validate_job_options(mode: str, language: str, title: str) -> tuple[str, str, str]:
    if mode not in TRANSCRIPTION_MODES:
        raise ValueError("转写模式无效")
    if language not in SUPPORTED_LANGUAGES:
        raise ValueError("口播语言无效")
    normalized_title = " ".join(str(title).split())[:300]
    return mode, language, normalized_title


def build_initial_prompt(title: str, description: str) -> str:
    normalized_title = " ".join(str(title).split())
    normalized_description = " ".join(str(description).split())
    hashtags = " ".join(
        f"#{term}" for term in dict.fromkeys(re.findall(r"#([\u3400-\u9fff]{2,8})", normalized_description))
    )
    return "\n".join(
        part for part in (normalized_title, hashtags, normalized_description) if part
    )[:1200]


def correct_hashtag_homophones(text: str, prompt: str, pinyinizer=None) -> str:
    terms = set(re.findall(r"#([\u3400-\u9fff]{2,8})", prompt))
    if not terms:
        return text
    if pinyinizer is None:
        try:
            from pypinyin import lazy_pinyin
        except ImportError:
            return text
        pinyinizer = lambda value: tuple(lazy_pinyin(value))

    expected_terms = [
        (term, tuple(pinyinizer(term))) for term in sorted(terms, key=len, reverse=True)
    ]
    corrected = list(text)
    for match in re.finditer(r"[\u3400-\u9fff]+", text):
        segment = match.group(0)
        pronunciations = tuple(pinyinizer(segment))
        for term, expected in expected_terms:
            length = len(term)
            for offset in range(len(segment) - length + 1):
                if segment[offset:offset + length] == term:
                    continue
                if pronunciations[offset:offset + length] == expected:
                    start = match.start() + offset
                    corrected[start:start + length] = term
    return "".join(corrected)


def correct_unambiguous_chinese_phrases(text: str) -> str:
    corrections = {
        "中年积雪的祁连山": "终年积雪的祁连山",
        "风沙漫天的戈壁大墓": "风沙漫天的戈壁大漠",
        "深蓝色的鼠锦": "深蓝色的蜀锦",
    }
    corrected = text
    for mistaken, expected in corrections.items():
        corrected = corrected.replace(mistaken, expected)
    return corrected


def find_mlx_whisper() -> Path | None:
    bundled = PROJECT_ROOT / ".venv" / "bin" / "mlx_whisper"
    if bundled.is_file():
        return bundled
    installed = shutil.which("mlx_whisper")
    return Path(installed) if installed else None


def build_accurate_command(
    executable: Path,
    audio_path: Path,
    output_directory: Path,
    language: str,
    title: str,
) -> list[str]:
    command = [
        str(executable),
        str(audio_path),
        "--model",
        ACCURATE_MODEL,
        "--task",
        "transcribe",
        "--condition-on-previous-text",
        "False",
        "--output-format",
        "txt",
        "--output-dir",
        str(output_directory),
        "--output-name",
        "transcript",
        "--verbose",
        "False",
    ]
    if language != "auto":
        command.extend(["--language", language])
    if title:
        command.extend(["--initial-prompt", title])
    return command


@dataclass
class Job:
    id: str
    url: str
    directory: Path
    mode: str = "fast"
    language: str = "auto"
    title: str = ""
    status: str = "queued"
    progress: int = 0
    error: str | None = None
    audio_path: Path | None = None
    transcript_path: Path | None = None
    process: subprocess.Popen[str] | None = field(default=None, repr=False)

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "error": self.error,
            "mode": self.mode,
        }


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(
        self,
        url: str,
        mode: str = "fast",
        language: str = "auto",
        title: str = "",
    ) -> Job:
        url = validate_youtube_url(url)
        mode, language, title = validate_job_options(mode, language, title)
        job_id = uuid.uuid4().hex
        directory = Path(tempfile.mkdtemp(prefix="ytse-"))
        job = Job(job_id, url, directory, mode=mode, language=language, title=title)
        with self._lock:
            self._jobs[job_id] = job
        threading.Thread(target=self._download, args=(job,), daemon=True).start()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def delete(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if not job:
            return False
        if job.process and job.process.poll() is None:
            job.process.terminate()
            try:
                job.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                job.process.kill()
        shutil.rmtree(job.directory, ignore_errors=True)
        return True

    def close(self) -> None:
        with self._lock:
            job_ids = list(self._jobs)
        for job_id in job_ids:
            self.delete(job_id)

    def _download(self, job: Job) -> None:
        yt_dlp = shutil.which("yt-dlp")
        ffmpeg = shutil.which("ffmpeg")
        if not yt_dlp:
            job.status = "error"
            job.error = "未找到 yt-dlp，请先安装：python3 -m pip install yt-dlp"
            return
        if not ffmpeg:
            job.status = "error"
            job.error = "未找到 FFmpeg，请先安装：brew install ffmpeg"
            return

        job.status = "downloading"
        output_template = str(job.directory / "audio.%(ext)s")
        command = [
            yt_dlp,
            "--no-playlist",
            "--no-warnings",
            "--write-info-json",
            "--extract-audio",
            "--audio-format",
            "wav",
            "--audio-quality",
            "0",
            "--newline",
            "--progress-template",
            "download:%(progress._percent_str)s",
            "--ffmpeg-location",
            ffmpeg,
            "-o",
            output_template,
            job.url,
        ]
        try:
            job.process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            output_tail: list[str] = []
            assert job.process.stdout is not None
            for line in job.process.stdout:
                stripped = line.strip()
                if stripped:
                    output_tail.append(stripped)
                    output_tail = output_tail[-8:]
                match = re.search(r"download:\s*([0-9.]+)%", stripped)
                if match:
                    job.progress = min(99, round(float(match.group(1))))
            return_code = job.process.wait()
            if return_code != 0:
                raise RuntimeError(output_tail[-1] if output_tail else f"yt-dlp 退出码 {return_code}")
            audio_files = list(job.directory.glob("audio.wav"))
            if not audio_files:
                raise RuntimeError("音频转换完成，但没有找到 WAV 文件")
            job.audio_path = audio_files[0]
            if job.mode == "accurate":
                description = ""
                info_path = job.directory / "audio.info.json"
                if info_path.is_file():
                    try:
                        info = json.loads(info_path.read_text(encoding="utf-8"))
                        description = str(info.get("description", ""))
                    except (OSError, json.JSONDecodeError):
                        pass
                job.title = build_initial_prompt(job.title, description)
                self._transcribe(job)
            else:
                job.progress = 100
                job.status = "ready"
        except Exception as error:  # noqa: BLE001 - surfaced to local UI
            job.status = "error"
            job.error = str(error)

    def _transcribe(self, job: Job) -> None:
        executable = find_mlx_whisper()
        if not executable:
            raise RuntimeError(
                "未安装高精度模型环境，请在扩展目录运行：python3 -m venv .venv && "
                ".venv/bin/pip install mlx-whisper"
            )
        if not job.audio_path:
            raise RuntimeError("音频尚未准备完成")

        job.status = "transcribing"
        job.progress = 0
        command = build_accurate_command(
            executable,
            job.audio_path,
            job.directory,
            job.language,
            job.title,
        )
        job.process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        output, _ = job.process.communicate()
        if job.process.returncode != 0:
            output_tail = "\n".join(output.splitlines()[-8:])
            raise RuntimeError(output_tail or f"Whisper 退出码 {job.process.returncode}")
        transcript_path = job.directory / "transcript.txt"
        if not transcript_path.is_file() or not transcript_path.read_text(encoding="utf-8").strip():
            raise RuntimeError("Whisper 没有识别出可导出的文字")
        transcript = transcript_path.read_text(encoding="utf-8")
        transcript_path.write_text(
            correct_hashtag_homophones(
                correct_unambiguous_chinese_phrases(transcript),
                job.title,
            ),
            encoding="utf-8",
        )
        job.transcript_path = transcript_path
        job.progress = 100
        job.status = "ready"


JOBS = JobManager()
atexit.register(JOBS.close)


class Handler(BaseHTTPRequestHandler):
    server_version = "YouTubeSubtitleExporterHelper/1.0"

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.scheme == "chrome-extension" and bool(parsed.hostname)

    def _require_allowed_origin(self) -> bool:
        if self._origin_allowed():
            return True
        self.send_response(HTTPStatus.FORBIDDEN)
        self.end_headers()
        return False

    def _json(self, status: int, value: object) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not self._require_allowed_origin():
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if not self._require_allowed_origin():
            return
        if self.path != "/jobs":
            self._json(HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8192:
                raise ValueError("请求内容无效")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("请求内容无效")
            job = JOBS.create(
                str(payload.get("url", "")),
                str(payload.get("mode", "fast")),
                str(payload.get("language", "auto")),
                str(payload.get("title", "")),
            )
            self._json(HTTPStatus.ACCEPTED, job.public())
        except (ValueError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def do_GET(self) -> None:  # noqa: N802
        if not self._require_allowed_origin():
            return
        if self.path == "/health":
            self._json(HTTPStatus.OK, {"ok": True, "service": "youtube-subtitle-exporter"})
            return
        match = re.fullmatch(r"/jobs/([a-f0-9]{32})(/(?:audio|transcript))?", self.path)
        if not match:
            self._json(HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
            return
        job = JOBS.get(match.group(1))
        if not job:
            self._json(HTTPStatus.NOT_FOUND, {"error": "任务不存在或已清理"})
            return
        resource = match.group(2)
        if not resource:
            self._json(HTTPStatus.OK, job.public())
            return
        if resource == "/transcript":
            if job.status != "ready" or not job.transcript_path:
                self._json(HTTPStatus.CONFLICT, {"error": "文字稿尚未准备完成"})
                return
            try:
                body = job.transcript_path.read_bytes()
                self.send_response(HTTPStatus.OK)
                self._cors()
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if job.status != "ready" or not job.audio_path:
            self._json(HTTPStatus.CONFLICT, {"error": "音频尚未准备完成"})
            return
        try:
            size = job.audio_path.stat().st_size
            self.send_response(HTTPStatus.OK)
            self._cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with job.audio_path.open("rb") as audio_file:
                shutil.copyfileobj(audio_file, self.wfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._require_allowed_origin():
            return
        match = re.fullmatch(r"/jobs/([a-f0-9]{32})", self.path)
        if not match:
            self._json(HTTPStatus.NOT_FOUND, {"error": "接口不存在"})
            return
        deleted = JOBS.delete(match.group(1))
        self._json(HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND, {"ok": deleted})

    def log_message(self, format: str, *args: object) -> None:
        print(f"[helper] {self.address_string()} {format % args}")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"YouTube 字幕导出器本地助手已启动：http://{HOST}:{PORT}")
    print("请保持此窗口开启；按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        JOBS.close()


if __name__ == "__main__":
    main()
