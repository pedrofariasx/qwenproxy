#!/usr/bin/env bash
set -euo pipefail

ensure_writable_dir() {
  local dir="$1"

  mkdir -p "$dir"

  if [ "$(id -u)" = "0" ]; then
    chown -R pwuser:pwuser "$dir" 2>/dev/null || true
  fi

  if ! gosu pwuser test -w "$dir"; then
    echo "Error: $dir is not writable by pwuser. Check Docker volume permissions." >&2
    exit 1
  fi
}

ensure_writable_dir /app/data
ensure_writable_dir /app/qwen_profiles
ensure_writable_dir /tmp/playwright

exec gosu pwuser "$@"
