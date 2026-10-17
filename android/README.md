# Resource Radar Android app

This directory is a standalone Android Studio/Gradle project for Resource Radar.
It uses a small Java `Activity` with a local responsive WebView UI and an embedded
Android yt-dlp/Python/QuickJS/FFmpeg runtime (yt-dlp 2026.08.19). It does not use the Windows `.exe`
helpers or Termux.

The Android application ID and Java namespace are `com.rhinzler.resourceradar`.

## Local build

Requirements:

- JDK 17
- Android SDK Platform 35 or 36
- Android SDK Build-Tools 36.x
- Android ABI `arm64-v8a` or `x86_64`

From this directory:

```powershell
.\gradlew.bat assembleDebug --offline
```

When the local Gradle cache does not contain the Maven AAPT2 artifact, the installed
Android SDK build-tools binary can be used for an offline build:

```powershell
$androidSdk = $env:ANDROID_HOME
.\gradlew.bat assembleDebug --offline "-Pandroid.aapt2FromMavenOverride=$androidSdk\build-tools\36.0.0\aapt2.exe"
```

If the wrapper has not been generated in a fresh checkout, use an installed Gradle
9.3.1 distribution (or run `gradle wrapper --gradle-version 9.3.1` once):

```powershell
gradle wrapper --gradle-version 9.3.1
gradle assembleDebug --offline
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

## APK output

The debug APK is written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

It is a debug-signed APK for local installation/testing, not a Play Store release.
For a release build, configure a release keystore and run `assembleRelease`.

## Bridge and scope

The local page exposes the desktop-compatible method names through
`window.resourceRadar`:

`scanPage`, `inspectPlatform`, `getMediaToolStatus`, `downloadResources`,
`downloadPlatformMedia`, `cancelDownloads`, `openDownloads`, and `onDownloadEvent`.

`ResourceRadarBridge` delegates those calls to `NativeResourceService`. The backend
uses public HTTPS checks with per-redirect DNS validation, Jsoup for direct-resource
discovery, MediaStore pending rows for safe Downloads output, and the embedded
yt-dlp/QuickJS/FFmpeg libraries for supported public platform videos. Direct files
run up to three at once; playlists run sequentially oldest-first in
`Downloads/Playlist`. New platform filenames omit the trailing media ID and use
collision-safe Android Downloads rows.

The shell accepts only public HTTPS URLs at this seam, rejects obvious local/private
hosts, prevents remote WebView navigation, and disallows cleartext traffic. A future
native service must retain those public-only and storage-safe boundaries.

## Runtime and limitations

- Public HTTPS URLs only. No cookies, sign-in, private tokens, DRM bypass, or
  paywall circumvention.
- Platform extraction depends on the public extractor's current support and may
  fail when a site requires an account or protected access.
- The APK bundles yt-dlp 2026.08.19 rather than the older 2025.11.12 runtime
  shipped by the upstream Android library. This avoids a stale-extractor class
  of YouTube/Instagram failures while retaining the public-only boundary.
- Android 10+ MediaStore is used without broad storage permissions. The system
  Downloads view opens the Downloads collection; Android decides how its provider
  presents subfolders.
- Third-party notices are bundled at `app/src/main/assets/third-party-notices.txt`.
