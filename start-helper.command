#!/bin/zsh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"
export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")"
if [[ -x ".venv/bin/python" ]]; then
  export PATH="$PWD/.venv/bin:$PATH"
  exec .venv/bin/python -B -m local_helper.server
fi
exec python3 -B -m local_helper.server
