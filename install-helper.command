#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"
project_root="$(cd "$(dirname "$0")" && pwd)"
extension_id="${1:-}"

if [[ -z "$extension_id" ]]; then
  echo "首次安装需要当前插件 ID。"
  echo "请打开 chrome://extensions，开启开发者模式，并复制“视频字幕文字稿”的 ID。"
  read -r "extension_id?插件 ID："
fi

if [[ ! "$extension_id" =~ ^[a-p]{32}$ ]]; then
  echo "插件 ID 格式不正确，应为 32 位 a-p 小写字母。"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 python3，请先安装 Python 3。"
  exit 1
fi

host_name="com.skystmm.video_subtitle_helper"
agent_label="com.skystmm.video-subtitle-helper"
install_root="$HOME/Library/Application Support/VideoSubtitleHelper"
host_path="$install_root/native-host.command"
agent_path="$HOME/Library/LaunchAgents/$agent_label.plist"
chrome_manifest="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$host_name.json"
edge_manifest="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/$host_name.json"
log_path="$HOME/Library/Logs/video-subtitle-helper.log"
error_log_path="$HOME/Library/Logs/video-subtitle-helper-error.log"

mkdir -p "$install_root/local_helper" "$(dirname "$chrome_manifest")" "$(dirname "$edge_manifest")" "$(dirname "$agent_path")" "$(dirname "$log_path")"
cp "$project_root/start-helper.command" "$install_root/start-helper.command"
cp "$project_root/native-host.command" "$host_path"
for source_file in "$project_root"/local_helper/*.py; do
  cp "$source_file" "$install_root/local_helper/"
done
chmod +x "$host_path" "$install_root/start-helper.command"

if [[ ! -x "$install_root/.venv/bin/python" ]]; then
  echo "正在安装独立的本地助手运行环境，首次安装需要几分钟…"
  python3 -m venv "$install_root/.venv"
fi
if ! "$install_root/.venv/bin/python" -m pip show mlx-whisper pypinyin yt-dlp >/dev/null 2>&1; then
  "$install_root/.venv/bin/python" -m pip install --upgrade mlx-whisper pypinyin yt-dlp
fi

python3 - "$extension_id" "$host_name" "$host_path" "$chrome_manifest" "$edge_manifest" "$agent_label" "$install_root/start-helper.command" "$install_root" "$agent_path" "$log_path" "$error_log_path" <<'PY'
import json
import plistlib
from pathlib import Path
import sys

(
    extension_id,
    host_name,
    host_path,
    chrome_manifest,
    edge_manifest,
    agent_label,
    starter_path,
    project_root,
    agent_path,
    log_path,
    error_log_path,
) = sys.argv[1:]

native_manifest = {
    "name": host_name,
    "description": "Video Subtitle Transcript local Whisper helper",
    "path": host_path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
for destination in (chrome_manifest, edge_manifest):
    Path(destination).write_text(
        json.dumps(native_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

launch_agent = {
    "Label": agent_label,
    "ProgramArguments": ["/bin/zsh", starter_path],
    "WorkingDirectory": project_root,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "ProcessType": "Background",
    "StandardOutPath": log_path,
    "StandardErrorPath": error_log_path,
}
with Path(agent_path).open("wb") as output:
    plistlib.dump(launch_agent, output)
PY

launchctl bootout "gui/$UID" "$agent_path" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$agent_path"
launchctl kickstart -k "gui/$UID/$agent_label" >/dev/null 2>&1 || true

echo
echo "本地助手安装完成。"
echo "插件 ID：$extension_id"
echo "安装目录：$install_root"
echo "日志：$log_path"
echo "请在 chrome://extensions 重新加载插件，然后刷新视频页面。"
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "提示：尚未检测到 FFmpeg，高准确率转写前请运行 brew install ffmpeg。"
fi
