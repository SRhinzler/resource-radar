# Resource Radar Android app

This directory is a standalone Android Studio/Gradle project for Resource Radar.
It uses a small Java `Activity` with a local responsive WebView UI and an embedded
Android yt-dlp/Python/QuickJS/FFmpeg runtime (yt-dlp 2026.08.19). It does not use the Windows `.exe`
helpers or Termux.

The Android application ID and Java namespace are `com.rhinzler.resourceradar`.

## Local build

Requirements:

- JDK 17
- Android SDK Platform 36
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
The Android bridge also exposes `getDownloadHistory`, `clearDownloadHistory`, and
`openDownload` for the native completed-file history UI, plus `checkForUpdates`,
`getUpdateStatus`, `downloadUpdate`, and `openUpdateInstallSettings` for the native
GitHub release update flow.
Update download requests do not accept a renderer URL or URI.

`ResourceRadarBridge` delegates those calls to `NativeResourceService`. The backend
uses public HTTPS checks with per-redirect DNS validation, Jsoup for direct-resource
discovery, MediaStore pending rows for safe Downloads output, and the embedded
yt-dlp/QuickJS/FFmpeg libraries for supported public platform videos. Direct files
  run up to three at once; playlists run sequentially oldest-first in a sanitized,
  playlist-specific `Downloads/Playlist/<folder>` directory derived from the YouTube list
metadata and URL. New platform filenames omit the trailing media ID and use
collision-safe Android Downloads rows. Completed rows are retained in bounded
download history and can be opened again through their validated MediaStore content
URI.

The local WebView persists its dark-mode choice and up to 20 successfully scanned
public URLs. The hamburger menu opens distinct in-app Scanner, URL history, and
Download history views; each history view has Back/Home navigation and retains the
existing restore/open/clear behavior. Download history contains completed files only,
has explicit empty/error states, and clearing it removes history metadata without
deleting the saved MediaStore files. Theme selection remains persistent.
AndroidX Activity 1.6.1 supplies the lifecycle-owned Back dispatcher for button/gesture
navigation, including Android 13+ predictive-back callbacks; no legacy Back override
or lint suppression is used.

An automatic check runs once when the local UI opens; **Check for updates** is also
available in the menu. The native `PublicHttp`/OkHttp client queries the fixed HTTPS
`https://api.github.com/repos/SRhinzler/resource-radar/releases/latest` endpoint,
rejects redirects, bounds the response to 512 KiB, and verifies that the release is
neither a draft nor a prerelease. The scanner remains usable while checking. Manual
checks show a no-release, no-update, missing-APK, rate-limit, or network error state.
Release titles/notes are rendered with `textContent` as untrusted plain text.

Release tags use numeric versions such as `v1`, `v2`, `v2.1`, or `v2.1.0`; use these
shared formats when publishing both platforms. GitHub does not expose an Android
version code; an Android-specific numeric suffix (`v2.0+3`) can advertise versionName
`2.0`, versionCode `3` to an installed versionCode `2`. The APK must match the release's
numeric versionName (missing trailing components count as zero), match an explicitly
advertised code, and have this package name and a strictly greater versionCode. It
cannot downgrade the numeric versionName.

Before installer handoff, the native updater compares PackageManager signing
certificates: multi-signer APKs need the same current signer set; a single signer may
rotate forward only through Android-verified signing history. The system installer
also enforces compatibility. A differently production-signed APK cannot simply
replace a debug-signed build. The app remains versionName `2.0`, versionCode `2` in
this change.

Update requests accept no renderer URLs, paths, URIs, or download IDs. The native
updater selects a `.apk` asset whose HTTPS URL exactly matches this GitHub repository,
release tag, asset filename, and port 443, with no credentials, query, or fragment.
GitHub metadata must declare a size between 1 byte and 200 MiB and any supplied digest
must be SHA-256. Native DNS validation runs again before DownloadManager enqueue.
Android DownloadManager handles the public GitHub/CDN transfer, network retry, and
background notification. A persisted native record prevents duplicate enqueue and
binds verification to that particular release; checks during a download cannot replace
its expected size or digest. The menu reopens an existing transfer even while offline.
New-download authorization is session-only and cleared before a fresh check, so a
failed check cannot authorize a stale offer.

The completion receiver requires Android DownloadProvider's signature-level
`SEND_DOWNLOAD_COMPLETED_INTENTS` permission, checks the persisted ID, and re-queries
DownloadManager. A persisted JobScheduler verification job (protected by
`BIND_JOB_SERVICE`) copies at most the declared size/200 MiB into private app storage,
checks the exact byte count, optional GitHub SHA-256 digest, package name, advertised
version, increasing versionCode, and signing identity. Verification receipts are tied
to the policy revision and installed identity; stale receipts are reverified. The job
retries after process death or reboot; `RECEIVE_BOOT_COMPLETED`
is present solely to permit persisted jobs. Only the verified private `.apk` is served
by the non-exported, read-only `UpdateApkProvider`; the selected system installer gets
a read-grant content URI. No file URI is exposed to the renderer or installer.

When the app is visible, verification automatically opens Android's package installer.
Android restricts background activity launches, so completion in the background posts
an **update ready** notification and opens the installer automatically on the next
app resume. If notification permission is denied, reopening the app still works. If
unknown-app installation is blocked, the modal gives an actionable message and an
**Open install settings** button; returning after granting permission continues with
the already-verified APK. Canceling installation allows **Install again** without
another download. No cookies or tokens are sent.

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
- Android 10+ MediaStore is used without broad storage permissions. Playlist videos
  are stored under `Downloads/Playlist/<playlist folder>`, with the folder name
  derived from fetched playlist metadata and sanitized before insertion. The system
  Downloads view opens the Downloads collection; Android decides how its provider
  presents subfolders. File history opens only content URIs recorded after a
  published MediaStore row was verified.
- Third-party notices are bundled at `app/src/main/assets/third-party-notices.txt`.

## Repeatable Android smoke coverage

The standalone host-JDK test compiles the production `UpdatePolicy.java` with
`tests/UpdatePolicyTest.java` and checks numeric version, repository/asset URL, digest,
and signer/lineage decisions. Run from this directory with JDK 17+ on PATH:

```powershell
node ../scripts/check-android-update-policy.js "C:\path\to\existing\temp"
```

The root README also documents an offline Electron smoke of the Android HTML/JS.
Neither check exercises real DownloadManager, PackageManager archive verification,
provider grants, lifecycle jobs, or installation. There is no Android/JUnit harness.
After building, install `app/build/outputs/apk/debug/app-debug.apk` on an Android 10+
device or emulator and repeat this flow:

1. Open **Menu > Dark mode**, force-stop and relaunch the app; the dark WebView theme should
   remain selected. Scan two public HTTPS pages, relaunch, select a URL under **URL
   history**, and verify that it is restored without an automatic scan. Use **Clear**
   and verify the empty state.
2. Download one public direct file and one public video. After each completes, verify
   it appears under **Download history** after relaunch. Tap an entry and confirm
   Android opens the file through a viewer; delete one file outside the app and verify
   the entry reports **Missing** instead of opening an arbitrary path. Clear history
   and confirm the files remain in Android Downloads.
3. Inspect a YouTube playlist with a title and `list=` id, start the download, and
    verify the progress copy names `Downloads/Playlist/<sanitized playlist folder>`, entries
   run oldest-first, and duplicate titles receive distinct numbered/collision-safe
   MediaStore names. Cancel during an item and confirm no incomplete history entry is
   shown.
4. Open the hamburger menu and visit URL history and Download history as separate
   in-app views. Verify page Back/Home and Android's button/gesture Back return to
   the scanner, URL restore returns home and only fills the input, and download entries
   still open through Android content URIs. Do this during a media download and verify
   returning home retains the progress/results. Check both themes and a narrow screen.
5. Use **Check for updates** and verify the manual no-update or error state is
   informative. Turn on airplane mode, relaunch, and confirm automatic check failure
   does not open a blocking error modal or disable scanning. A manual check must show
   an error. Trigger a manual check while the automatic one is pending and verify it
   displays the result of that same check.
6. On a test device with an older, compatibly signed Resource Radar APK, check a
   newer public stable release containing its Android APK. Verify tag/title/size and
   changelog appear, with literal Markdown/HTML (no links or HTML execution). Tap
   Download rapidly and re-check from the menu; only one DownloadManager row should
   exist. Verify byte/percent progress and verification state; rotate, background,
   interrupt the network, then resume and confirm recovery without duplicate transfer.
7. Keep the app visible when verification finishes: the system package installer
   should open. Cancel, return, choose **Install again**, and confirm no re-download.
   With unknown-app installation disabled, use **Open install settings**, grant it,
   and return; the installer should use the saved verified file. Repeat with the app
   backgrounded/its process killed while downloading, and with notifications denied;
   reopen the app to continue. Repeat on Android 10 and a recent Android version.
8. In an isolated debug QA build/native fixture, exercise an equal/older version,
   `v2.0+3`, draft/prerelease, missing APK, size over 200 MiB, size mismatch, malformed
   or mismatched SHA-256, and a wrong-package/old-code/wrong-version/wrong-signer APK.
   Only a newer validated APK may reach the installer. Via the local debug bridge, attempt `downloadUpdate`
   or `openUpdateInstallSettings` with an HTTPS URL, content/file URI, or object payload;
   each must return `INVALID_REQUEST`. Foreign-repository assets, non-443 ports,
   query strings/fragments, and path traversal must never be enqueued. Host-JDK tests
   cover pure policy decisions; these end-to-end native scenarios still require a
   debug harness/device.

For a build-only repeatable check from this directory, run:

```powershell
.\gradlew.bat :app:assembleDebug --offline
```

The available JVM test task is also safe to run offline, but currently reports
`NO-SOURCE` because no Android test harness is configured:

```powershell
.\gradlew.bat :app:testDebugUnitTest --offline
```

Additional checks:

```powershell
node --check app/src/main/assets/app.js
.\gradlew.bat :app:lintDebug --offline
```

The offline lint task needs `com.android.tools.lint:lint-gradle:31.13.1` and declared
dependencies in the local Gradle cache. On a fresh machine, run without `--offline`
once to populate the cache. Missing dependencies fail before analysis; compilation
does not replace lint or a device smoke. The latest local build completed full lint
with **0 errors and 18 warnings**, without suppressing the Back-navigation check.
See [the verification receipt](../V2_VERIFICATION.md) for the current APK and limits.
