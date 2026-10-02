#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -n "${PYTHON:-}" ]; then
  exec "$PYTHON" ipc_entry.py "$@"
fi
if command -v python3 >/dev/null 2>&1; then
  exec python3 ipc_entry.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python ipc_entry.py "$@"
fi
printf '%s\n' 'Snake Transformer Studio needs Python 3.9 or later.' \
  'No Python packages are needed for standalone browser mode.' >&2
exit 1
