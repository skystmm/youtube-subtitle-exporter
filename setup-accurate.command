#!/bin/zsh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"
cd "$(dirname "$0")"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "高准确率模式需要 Apple Silicon Mac（M1/M2/M3/M4 或更新型号）。"
  read -r "?按回车键关闭…"
  exit 1
fi

python3 -m venv .venv
.venv/bin/python -m pip install --upgrade mlx-whisper pypinyin
echo
echo "高准确率模式安装完成。首次识别时会下载约 3 GB 的完整 large-v3 模型。"
read -r "?按回车键关闭…"
