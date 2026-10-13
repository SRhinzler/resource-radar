# Android media-toolchain assessment

**Scope:** Android media helpers only. All implementation in this change is
under `android-toolchain/`; no root `src` files, Electron UI files, or Android
UI files were modified.

**Assessment date:** 2026-10-12

## Executive result

The Android app in `android/` now uses the reviewed `youtubedl-android` and
FFmpeg Android libraries for its on-device media runtime. The Termux material in
this document remains a reproducible fallback/source assessment; it is not
required by the APK and is not bundled into it.

The four checked-in Windows helpers are not Android-compatible replacements:

| Existing helper | Local observation | Android decision |
| --- | --- | --- |
| `bin/yt-dlp.exe` | Official Windows standalone, version `2026.08.19`, PE/x64 | Do not copy. Use the upstream Python package in Termux. |
| `bin/ffmpeg.exe` | FFmpeg `N-127276-g8e9db1f152-20261010`, MinGW `x86_64-w64-mingw32`, Windows target | Do not copy. Use the Android-targeted Termux FFmpeg package or a separately reviewed NDK build. |
| `bin/ffprobe.exe` | Same Windows/MinGW build family as FFmpeg | Do not copy. It is supplied by the same Android FFmpeg package. |
| `bin/deno.exe` | Deno `2.9.7`, `x86_64-pc-windows-msvc` | Blocked. No official Deno Android release artifact was found. |

The earlier practical fallback was **Termux + Python/yt-dlp + FFmpeg/ffprobe +
Node EJS runtime**. The current APK instead uses the embedded Android library
runtime described above, with Android MediaStore output and a foreground
download service. Termux remains useful for source/build investigation but is
not needed for normal APK operation.

## Evidence from public sources

* yt-dlp's official [Android installation guidance](https://github.com/yt-dlp/yt-dlp/wiki/Installation#android)
  tells Android users to use Termux, install Python and pip, install
  `yt-dlp[default]`, and optionally install FFmpeg. The same page's release
  matrix describes the official `yt-dlp_linux_aarch64` artifact as Linux, not
  Android; Android/Bionic is not a supported standalone release target there.
* yt-dlp's [EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS) supports Deno,
  Node, QuickJS, and Bun. It documents Node 22 or newer as a supported runtime
  and `--js-runtimes node`; the scaffold selects Node and disallows remote EJS
  components. yt-dlp 2026.08.19 pins `yt-dlp-ejs==0.8.0` in its public
  `pyproject.toml`.
* The official [Deno installation page](https://docs.deno.com/runtime/getting_started/installation/)
  says the runtime runs on macOS, Linux, and Windows, x64 and arm64, and its
  manual download table contains those platforms only. The v2.9.7 release
  assets likewise expose Windows, Linux, and macOS archives, not Android.
* The pinned [Termux FFmpeg recipe](https://raw.githubusercontent.com/termux/termux-packages/3e13ceaa08e462bb3e0eb6529135ad67f9a3a9c5/packages/ffmpeg/build.sh)
  configures `--target-os=android`, maps Termux `aarch64`, `arm`, `x86_64`,
  and `i686` architectures, and builds the FFmpeg command-line tools and
  libraries. It is a public Android build recipe rather than an unverified
  binary drop.
* The [Termux package-build documentation](https://github.com/termux/termux-packages/wiki/Building-packages)
  documents source SHA-256 verification and the Android API-level/toolchain
  settings. The pinned current recipe uses API level 24 (Android 7) as its
  default package build level.
* Android ABI names and packaging constraints are defined by the Android
  [NDK ABI guide](https://developer.android.com/ndk/guides/abis). The mapping
  used here is `arm64-v8a` → `aarch64`, `armeabi-v7a` → `arm`, and `x86_64` →
  `x86_64`; legacy `x86` → `i686` is kept as an emulator note only.

## Target ABIs

| Priority | Android ABI | Termux build name | Intended use |
| --- | --- | --- | --- |
| Required | `arm64-v8a` | `aarch64` | Modern physical Android devices. |
| Optional | `armeabi-v7a` | `arm` | 32-bit ARM devices that still need support. |
| Optional | `x86_64` | `x86_64` | 64-bit emulator and x86_64 devices. |
| Legacy only | `x86` | `i686` | Do not make this part of the default release set without a specific emulator requirement. |

The API level in the manifest is a Termux package-build input, not a decision
about the Android app's `minSdk`. The Android app owner must choose and test
its own `minSdk`/NDK version.

## What was implemented

### Source and license manifest

[`android-toolchain/toolchain-manifest.json`](./android-toolchain/toolchain-manifest.json)
records public source URLs, exact source hashes where available, the pinned
Termux package commit, target ABI mapping, runtime policy, and the explicit
Deno blocker. No helper binary is checked in.

The source inputs currently pinned are:

| Component | Version | SHA-256 | Public source/license note |
| --- | --- | --- | --- |
| yt-dlp release tarball | 2026.08.19 | `072aad4f2a7604e92155f61a275a4752dc64046c8f6d90df3710525d94cd37c1` | Official release `SHA2-256SUMS`; Unlicense with the tarball's MIT/ISC JavaScript components. |
| yt-dlp-ejs wheel | 0.8.0 | `79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4` | PyPI metadata; Unlicense with MIT and ISC components. |
| FFmpeg source | 8.1.3 | `7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3` | Official FFmpeg release; the pinned Termux recipe enables GPL/version-3 components. |
| Python source | 3.14.6 | `143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63` | Python.org source; PSF-2.0 plus bundled dependency licenses. |
| Node source | 26.4.0 | `9eceb3621024069d91035b5471d2ebe86aa04d22dbeba72a782eaf36ff9183ac` | Node.js source; MIT plus bundled dependency licenses. |

`termux/verify-sources.sh` downloads only these public source/package inputs,
checks their hashes, and removes its temporary directory. It does not fetch a
native executable. The optional upstream signature checks should also be kept
in the release process: FFmpeg documents PGP verification on its
[download page](https://ffmpeg.org/download.html), and yt-dlp publishes signed
SHA-256/SHA-512 checksum files and a public key in its
[release-file documentation](https://github.com/yt-dlp/yt-dlp#release-files).

### Termux installation script

`termux/install-media-tools.sh` installs the public Termux packages and pins
the expected versions used by the manifest:

```text
python 3.14.6
ffmpeg/ffprobe 8.1.3
node 26.4.0
yt-dlp 2026.08.19
```

It fails on version drift instead of silently continuing with an unreviewed
toolchain. If the Termux repository moves to another version, update the
manifest, source hashes, and this script together after review.

### Fixed downloader interface

`termux/media-tool.sh` is the next buildable interface for an Android bridge:

```text
media-tool.sh metadata <http(s)-url>
media-tool.sh download <http(s)-url> <absolute-output-dir> [max-height]
```

The wrapper:

* accepts only HTTP(S) URLs and one item at a time;
* rejects playlist URLs until the Android queue layer is implemented;
* passes `--ignore-config`, `--no-remote-components`, and explicit Node EJS
  runtime flags;
* never accepts cookie, token, browser-profile, or arbitrary yt-dlp option
  arguments;
* keeps output below `RR_MEDIA_OUTPUT_ROOT` (default:
  `$HOME/storage/downloads` after `termux-setup-storage`); and
* emits the same `RR_PROGRESS|downloaded|total|speed|eta|status` progress
  shape used by the existing media parser.

For an Android UI integration, use the documented
[Termux `RUN_COMMAND` intent](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent)
with an explicit command path and argument array. The Android layer must own
the permission declaration, Termux-installed state, cancellation, lifecycle,
stdout/stderr collection, and Android Storage Access Framework decisions. Those
changes are outside this toolchain-only scope.

## Android integration status

1. `android/` is a native Gradle project targeting API 36 with `arm64-v8a` and
   `x86_64` debug APK outputs.
2. The APK uses `youtubedl-android:0.18.1` and its `ffmpeg:0.18.1` artifact,
   with the app-level `res/raw/ytdlp` override pinned to official yt-dlp
   2026.08.19; the existing Windows helpers are never copied into the APK.
3. Deno is still intentionally not used. The Android library supplies an
   Android-compatible Python/QuickJS path for the extractor runtime.
4. Android downloads use MediaStore pending rows, private staging files, public
   HTTPS redirect/DNS checks, cancellation, and foreground process visibility.
5. This Windows workspace has no connected Android device, so device install and
   public-media smoke testing remain separate from the verified APK build.

## License and redistribution requirements

Before shipping anything beyond the Termux runtime scaffold:

* Keep the yt-dlp Unlicense and the official release tarball's MIT/ISC
  component notices, plus yt-dlp-ejs's Unlicense/MIT/ISC notices, with the
  app's third-party notices.
* Treat the pinned Termux FFmpeg configuration as GPL-3.0 because it enables
  GPL and version-3 components. Include corresponding source, build
  configuration, license text, and any dependent codec notices. FFmpeg's
  [legal page](https://ffmpeg.org/legal.html) explains the LGPL baseline and
  when GPL components change the result.
* Keep Python PSF-2.0, Node MIT, Termux package notices, and all transitive
  dependency licenses. Do not assume that a package-manager install transfers
  redistribution obligations to the application.
* Verify every release archive against an upstream checksum/signature and
  record the exact Termux package commit and build command. Do not replace the
  manifest with a downloaded binary whose provenance is only a filename or a
  third-party mirror.

## Bounded verification performed here

* `yt-dlp.exe --version` → `2026.08.19`.
* `ffmpeg.exe -version` and `ffprobe.exe -version` → Windows MinGW
  `x86_64-w64-mingw32` build, not Android.
* `deno.exe --version` → `deno 2.9.7 ... x86_64-pc-windows-msvc`.
* SHA-256 of each existing Windows helper matches the root `bin/manifest.json`.
* `node android-toolchain/scripts/verify-toolchain.js` verifies the new
  scaffold metadata and the absence of native binaries.

An Android device build, Termux install, native NDK build, or public media
download was not run from this Windows host. The scaffold therefore records a
buildable path and its blockers without claiming Android parity.
