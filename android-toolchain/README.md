# Android media-toolchain reference

This directory is the Android-only media-toolchain boundary for Resource Radar.
It deliberately contains **source references, verification metadata, and shell
interfaces only**. It does not contain copied executables, APKs, native
libraries, cookies, tokens, or a second Android UI.

## Current decision

The checked-in Windows helpers cannot be reused on Android. The buildable local
path identified here is a **Termux-owned runtime**:

1. Install Termux from one official distribution source and run
   `termux-setup-storage`.
2. Run `termux/verify-sources.sh` to verify the public source archives listed
   in `toolchain-manifest.json`.
3. Run `termux/install-media-tools.sh` to install the documented Termux
   packages for Python, FFmpeg/ffprobe, and Node, then install the pinned
   `yt-dlp` Python package.
4. Call `termux/media-tool.sh` from the Android integration layer. It exposes
   only fixed `metadata` and `download` operations, disables yt-dlp config and
   remote components, and accepts public HTTP(S) URLs only.

The current `android/` APK does not invoke this Termux interface. It uses the
embedded `youtubedl-android`/FFmpeg runtime instead. This directory remains a
source-reference and fallback assessment for future ABI/toolchain work; it is
not part of the APK and does not claim to be an install prerequisite.

## Checks from the Windows checkout

```powershell
node android-toolchain/scripts/verify-toolchain.js
npm test
```

The first command checks the manifest, HTTPS source URLs, SHA-256 metadata, ABI
names, and that no native binaries were accidentally added below this
directory. It does not claim that an Android device build or an Android media
download has passed.

See [`ANDROID_MEDIA_TOOLCHAIN.md`](./ANDROID_MEDIA_TOOLCHAIN.md) for the
compatibility decision, blockers, licensing obligations, and the next Android
integration contract.
