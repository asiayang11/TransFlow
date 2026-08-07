#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
babeldoc_python="$project_root/.venv-babeldoc/bin/python"
local_python="$project_root/.venv/bin/python"
bundled_python="/Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12"

if [[ -x "$babeldoc_python" ]]; then
  python_bin="$babeldoc_python"
elif [[ -x "$local_python" ]]; then
  python_bin="$local_python"
elif [[ -x "$bundled_python" ]]; then
  python_bin="$bundled_python"
else
  python_bin="${PYTHON_BIN:-python3}"
fi

cd "$project_root"
exec "$python_bin" server/app.py
