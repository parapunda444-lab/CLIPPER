#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo 'FFmpeg and ffprobe are required; install the ffmpeg package for your OS.' >&2
  exit 1
fi
if ! command -v yt-dlp >/dev/null; then
  uv tool install yt-dlp
fi
npm run demo
