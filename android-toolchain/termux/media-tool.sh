#!/data/data/com.termux/files/usr/bin/bash
set -eu

usage() {
  cat >&2 <<'EOF'
Usage:
  media-tool.sh metadata <http(s)-url>
  media-tool.sh download <http(s)-url> <output-dir> [max-height]

The download output directory must be inside RR_MEDIA_OUTPUT_ROOT. The default
root is $HOME/storage/downloads after `termux-setup-storage`.
EOF
  exit 2
}

die() {
  printf 'Android media-tool failed: %s\n' "$1" >&2
  exit 1
}

[ "$#" -ge 2 ] || usage
operation="$1"
url="$2"

case "$url" in
  http://*|https://*) ;;
  *) die 'only public http:// and https:// URLs are accepted' ;;
esac
case "$url" in
  *$'\n'*|*$'\r'*) die 'the URL contains a line break' ;;
esac

# Playlist queueing remains an Android integration responsibility. This fixed
# interface intentionally handles one public video/resource at a time.
case "$url" in
  *youtube.com/playlist*|*youtube.com/watch\?*list=*|*youtu.be/*\?*list=*)
    die 'playlist URLs are not exposed by this single-item interface'
    ;;
esac

command -v yt-dlp >/dev/null 2>&1 || die 'yt-dlp is missing; run install-media-tools.sh'
command -v node >/dev/null 2>&1 || die 'Node is missing; run install-media-tools.sh'
command -v ffmpeg >/dev/null 2>&1 || die 'ffmpeg is missing; run install-media-tools.sh'
command -v ffprobe >/dev/null 2>&1 || die 'ffprobe is missing; run install-media-tools.sh'

node_path="$(command -v node)"
ffmpeg_path="$(command -v ffmpeg)"

# Do not read user yt-dlp configuration, cookies, or remote EJS components.
base_args=(
  --ignore-config
  --no-cache-dir
  --no-update
  --no-warnings
  --no-color
  --no-remote-components
  --no-js-runtimes
  --js-runtimes "node:${node_path}"
)

case "$operation" in
  metadata)
    [ "$#" -eq 2 ] || usage
    exec yt-dlp "${base_args[@]}" \
      --skip-download \
      --dump-single-json \
      --no-playlist \
      -- "$url"
    ;;
  download)
    [ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage
    output_dir="$3"
    max_height="${4:-}"

    case "$output_dir" in
      /*) ;;
      *) die 'output-dir must be an absolute path' ;;
    esac
    if [ -n "$max_height" ]; then
      case "$max_height" in
        *[!0-9]*) die 'max-height must be a positive integer' ;;
        0) die 'max-height must be a positive integer' ;;
      esac
    fi

    output_root="${RR_MEDIA_OUTPUT_ROOT:-$HOME/storage/downloads}"
    mkdir -p -- "$output_root" "$output_dir"
    output_root="$(cd "$output_root" && pwd -P)"
    output_dir="$(cd "$output_dir" && pwd -P)"
    case "$output_dir" in
      "$output_root"|"$output_root"/*) ;;
      *) die 'output-dir is outside RR_MEDIA_OUTPUT_ROOT' ;;
    esac

    if [ -n "$max_height" ]; then
      format_selector="bv*[height<=${max_height}]+ba/b[height<=${max_height}]/b[height<=${max_height}]"
    else
      format_selector='bv*+ba/b'
    fi

    progress_template='download:RR_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s|%(progress.status)s'
    exec yt-dlp "${base_args[@]}" \
      --no-playlist \
      --newline \
      --progress \
      --progress-template "$progress_template" \
      --paths "home:${output_dir}" \
      --output '%(title)s.%(ext)s' \
      --windows-filenames \
      --trim-filenames 160 \
      --no-overwrites \
      --format "$format_selector" \
      --ffmpeg-location "$(dirname "$ffmpeg_path")" \
      --print after_move:filepath \
      -- "$url"
    ;;
  *)
    usage
    ;;
esac
