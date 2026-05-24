#!/bin/bash
# Run parakeet-mlx and print the transcript text to stdout for xport_daemon.py.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: xport_transcribe_parakeet.sh <media-file>" >&2
  exit 2
fi

INPUT_PATH="$1"
PARAKEET_BIN="${PARAKEET_MLX_BIN:-}"
FFMPEG_BIN="${FFMPEG_BIN:-}"

if [ -z "$PARAKEET_BIN" ]; then
  PARAKEET_BIN="$(command -v parakeet-mlx || true)"
fi

if [ -z "$PARAKEET_BIN" ] || [ ! -x "$PARAKEET_BIN" ]; then
  echo "parakeet-mlx is not installed or not executable" >&2
  exit 127
fi

if [ -z "$FFMPEG_BIN" ]; then
  FFMPEG_BIN="$(command -v ffmpeg || true)"
fi

if [ -z "$FFMPEG_BIN" ] || [ ! -x "$FFMPEG_BIN" ]; then
  echo "ffmpeg is not installed or not executable" >&2
  exit 127
fi

OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xport-parakeet.XXXXXX")"
cleanup() {
  rm -rf "$OUT_DIR"
}
trap cleanup EXIT

AUDIO_PATH="$OUT_DIR/source.wav"
"$FFMPEG_BIN" -hide_banner -loglevel error -y -i "$INPUT_PATH" -vn -ac 1 -ar 16000 "$AUDIO_PATH"
"$PARAKEET_BIN" --output-format txt --output-dir "$OUT_DIR" "$AUDIO_PATH" >&2

TRANSCRIPT_PATH="$(find "$OUT_DIR" -type f -name '*.txt' -print -quit)"
if [ -z "$TRANSCRIPT_PATH" ]; then
  echo "parakeet-mlx did not produce a transcript file" >&2
  exit 1
fi

cat "$TRANSCRIPT_PATH"
