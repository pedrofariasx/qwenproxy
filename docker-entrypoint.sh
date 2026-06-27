#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/data /app/qwen_profiles /tmp/playwright
chown -R pwuser:pwuser /app/data /app/qwen_profiles /tmp/playwright

exec gosu pwuser "$@"
