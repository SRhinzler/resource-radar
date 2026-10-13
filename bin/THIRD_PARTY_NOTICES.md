# Bundled media tool notices

Resource Radar packages the following Windows x64 helper executables inside the installer so users do not need to install another application:

- **yt-dlp 2026.08.19** — standalone executable from the official yt-dlp release. The combined executable is distributed under the GPLv3-or-later terms described by the upstream project. Source and license information: <https://github.com/yt-dlp/yt-dlp#license>.
- **FFmpeg N-127276-g8e9db1f152-20261010** — static GPL build from the yt-dlp FFmpeg Builds project. This build enables GPL and version-3 components. Source/build information and checksums: <https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/latest>.
- **Deno 2.9.7** — Windows x64 runtime used by yt-dlp for its bundled JavaScript challenge-solving components. License and source information: <https://github.com/denoland/deno>.

The exact asset URLs and SHA-256 values used for this build are recorded in `manifest.json`. These tools are invoked only for public, user-supplied media URLs. Resource Radar does not pass browser cookies, login credentials, or arbitrary extractor options to them.

When redistributing this application, keep this notice and the upstream license/source obligations with the installer. The helper versions are intentionally pinned; refresh them as part of a reviewed application release rather than updating them at runtime.
