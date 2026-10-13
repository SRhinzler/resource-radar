#!/data/data/com.termux/files/usr/bin/bash
set -eu

die() {
  printf 'Android media source verification failed: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die 'curl is required'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'

work_dir="$(mktemp -d 2>/dev/null || mktemp -d -t rr-media-sources)"
trap 'rm -rf "$work_dir"' EXIT

download_and_verify() {
  expected="$1"
  url="$2"
  file_name="$3"
  destination="$work_dir/$file_name"

  printf 'Downloading public source: %s\n' "$url"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$url" -o "$destination"
  printf '%s  %s\n' "$expected" "$destination" | sha256sum --check --status \
    || die "SHA-256 mismatch for $file_name"
  printf 'Verified %s (%s)\n' "$file_name" "$expected"
}

# These values mirror android-toolchain/toolchain-manifest.json. The archives
# are source or pure-Python package inputs; this script does not fetch a native
# executable or modify the app.
download_and_verify \
  '072aad4f2a7604e92155f61a275a4752dc64046c8f6d90df3710525d94cd37c1' \
  'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.tar.gz' \
  'yt-dlp-2026.08.19.tar.gz'

download_and_verify \
  '79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4' \
  'https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl' \
  'yt_dlp_ejs-0.8.0-py3-none-any.whl'

download_and_verify \
  '7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3' \
  'https://www.ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz' \
  'ffmpeg-8.1.3.tar.xz'

download_and_verify \
  '143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63' \
  'https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz' \
  'Python-3.14.6.tar.xz'

download_and_verify \
  '9eceb3621024069d91035b5471d2ebe86aa04d22dbeba72a782eaf36ff9183ac' \
  'https://nodejs.org/dist/v26.4.0/node-v26.4.0.tar.xz' \
  'node-v26.4.0.tar.xz'

printf 'All pinned public source inputs verified. No native binary was downloaded by this check.\n'
