#!/data/data/com.termux/files/usr/bin/bash
set -eu

die() {
  printf 'Android media-tool install failed: %s\n' "$1" >&2
  exit 1
}

command -v pkg >/dev/null 2>&1 || die 'run this script inside Termux'

yt_dlp_version="${RR_YTDLP_VERSION:-2026.08.19}"
expected_python="${RR_PYTHON_VERSION:-3.14.6}"
expected_ffmpeg="${RR_FFMPEG_VERSION:-8.1.3}"
expected_node="${RR_NODE_VERSION:-26.4.0}"

printf 'Updating the official Termux package indexes...\n'
pkg update
pkg install -y python python-pip ffmpeg nodejs

printf 'Installing yt-dlp %s and its default, non-Deno EJS package...\n' "$yt_dlp_version"
python -m pip install --upgrade --disable-pip-version-check \
  "yt-dlp[default]==${yt_dlp_version}"

python_version="$(python --version 2>&1 | awk '{print $2}')"
ffmpeg_version="$(ffmpeg -version 2>/dev/null | sed -n 's/^ffmpeg version \([^ ]*\).*/\1/p' | head -n 1)"
ffprobe_version="$(ffprobe -version 2>/dev/null | sed -n 's/^ffprobe version \([^ ]*\).*/\1/p' | head -n 1)"
node_version="$(node --version 2>/dev/null | sed 's/^v//')"
installed_yt_dlp="$(yt-dlp --version 2>/dev/null || true)"

[ "$installed_yt_dlp" = "$yt_dlp_version" ] \
  || die "yt-dlp version is $installed_yt_dlp, expected $yt_dlp_version"
[ "$python_version" = "$expected_python" ] \
  || die "Python version is $python_version, expected $expected_python"
[ "$ffmpeg_version" = "$expected_ffmpeg" ] \
  || die "FFmpeg version is $ffmpeg_version, expected $expected_ffmpeg"
[ "$ffprobe_version" = "$expected_ffmpeg" ] \
  || die "ffprobe version is $ffprobe_version, expected $expected_ffmpeg"
[ "$node_version" = "$expected_node" ] \
  || die "Node version is $node_version, expected $expected_node"

printf 'Android media tools ready:\n'
printf '  yt-dlp %s (Python/EJS)\n' "$installed_yt_dlp"
printf '  Python %s\n' "$python_version"
printf '  FFmpeg %s / ffprobe %s\n' "$ffmpeg_version" "$ffprobe_version"
printf '  Node %s (yt-dlp EJS runtime)\n' "$node_version"
printf 'Deno was intentionally not installed; no official Android artifact is declared.\n'
