#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  if command -v apt-get >/dev/null && [ "$(id -u)" -eq 0 ]; then
    apt-get update -qq
    apt-get install -y --no-install-recommends ffmpeg
  else
    echo 'Install FFmpeg and ffprobe for your OS, then run setup again.' >&2
    exit 1
  fi
fi
if ! command -v yt-dlp >/dev/null; then
  uv tool install yt-dlp
fi
npm run demo
