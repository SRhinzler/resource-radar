# Resource Radar

Resource Radar is a Windows desktop application that scans a public webpage for direct video and document links, lets the user choose what to keep, and saves the selected files in the Windows **Downloads** folder. It also uses the reviewed `yt-dlp` command-line helper to inspect and download public videos from YouTube, Dailymotion, LinkedIn, and Instagram, with a maximum-resolution selector.

## Scope and safety

- The app supports publicly reachable `http://` and `https://` pages and direct resources.
- It does not sign in, use browser cookies, bypass paywalls, defeat DRM, extract private tokens, or capture protected streams.
- JavaScript-heavy sites, HLS/DASH playlists, embedded players, and resources that require authentication may not expose a direct downloadable file. Those are intentionally reported as unsupported rather than bypassed.
- The Windows installer includes the reviewed `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, and Deno runtime in `resources/bin/`. Users do not need to install Python, Node, yt-dlp, FFmpeg, Deno, or any other helper application separately.
- YouTube playlists and courses shared as YouTube playlist URLs are inspected, sorted by upload date from oldest to newest, and downloaded one at a time into `Downloads\Playlist\<playlist folder>`, where the final folder is safely derived from the fetched playlist title or ID. Files use `1. `, `2. `, `3. ` prefixes. Unavailable/private entries are skipped without login attempts. A queue is limited to 100 available videos. The queue's **Open folder** button opens that playlist folder.
- Platform videos use clean titles without an appended `[video-id]`: for example, `Video by theplateindia.mp4` or `Playlist\<Playlist folder>\1. Introduction.mp4`. Single videos and direct resources stay in Downloads. If a title already exists, a normal `(1)`, `(2)`, etc. suffix prevents overwriting; concurrent equal-title downloads are isolated. This applies to new downloads, not previously saved files.
- The desktop app includes a hamburger menu with persistent dark/light mode, separate URL and completed-download history views, and a GitHub update checker for `SRhinzler/resource-radar`. Selecting a URL restores it to the scanner; selecting an available completed download opens the file. Updates are checked against published stable releases, verified against GitHub's SHA-256 asset digest when provided, and launched only after the Windows installer finishes downloading.
- LinkedIn `lnkd.in` share links are safely resolved before selecting the video extractor. Public LinkedIn videos work without login; expired links, sign-in walls, and unavailable posts remain unsupported. LinkedIn Learning courses requiring an account/subscription are not supported. A short link to another public website is scanned as that website instead.
- Multiple direct resources selected from a page download through a bounded queue with up to three active downloads at once. YouTube playlist downloads remain strictly sequential to preserve the requested oldest-first order.
- Download progress updates are emitted during transfer with byte counts, percentage when the server provides a total size, live speed, and ETA. Chunked responses without a `Content-Length` use an animated indeterminate bar while still showing downloaded bytes and speed.
- Requests are limited to public network addresses and follow only a small number of safe HTTP redirects.
- Downloaded media files are written only inside the current user's Windows Downloads directory. Preferences/history use the app's data directory; update installers use private temporary staging.

## Navigation and updates (v2)

Use the hamburger menu for **Scanner**, **URL history**, **Download history**, the
persistent **Dark/Light** switch, and **Check for updates**. Histories are separate
in-app pages; navigating between them preserves the scanner and download queue.
Clearing history deletes its records, not the downloaded files.

The app checks GitHub once on opening and offers newer stable releases in a popup
with release title, changelog, **Download**, and **Close**. A manual check also shows
the no-update/error state; automatic check failures do not block scanning. Changelogs
are displayed as plain text, never executable HTML. A check never downloads or
launches an installer by itself: select **Download** to approve that step.

On Windows, the transfer continues while the popup is closed (keep the app running).
**Check for updates** reopens active progress without starting another transfer.
The updater accepts only the checked repository/tag/asset, public HTTPS GitHub/CDN
addresses, and an installer of at most 500 MiB. Redirects and all DNS answers are
validated; vetted IPv4/IPv6 alternatives remain available for network fallback.
It checks the exact byte count and GitHub's SHA-256 asset digest when present before
opening the installer. This is not an Authenticode verification or a silent install:
Windows may still ask for security/install confirmation. On Android, DownloadManager
and the system package installer handle the background transfer/install flow; see
[Android update behavior and limitations](android/README.md).

Publish future stable releases in `SRhinzler/resource-radar` with numeric tags such
as `v2`, `v2.1`, or `v2.1.0`, a Windows setup `.exe`, and an Android `.apk`. Set the
application versions accordingly and increase the APK's versionCode; keep its
signing identity compatible. The release body supplies the changelog. Drafts,
prereleases, and equal/older versions are not offered. Install v2 manually first if
using v1, which did not include this updater. Building locally does not publish a
GitHub release.

## Run from source

```powershell
npm install
npm start
```

The source checkout includes the same pinned helpers in `bin/`. The `verify:bundle` step checks their SHA-256 values before a Windows build; missing or modified helpers stop the build instead of producing an installer that will fail after installation.

## Test

```powershell
npm test
```

The tests cover playlist destination/order, clean media names, concurrent title
collisions, direct-download worker limits, LinkedIn short-link routing, private-redirect
rejection, histories, and update version/asset/IPC behavior. Updater cases include
partial/corrupt responses, digest/size mismatch, exclusive staging, DNS fallback, and
public-address validation on redirects.

Run the offline navigation/updater UI smoke and the standalone Android policy tests
from the repository root, passing an existing temporary directory:

```powershell
npx electron scripts/smoke-v2-ui.js --smoke-temp="C:\path\to\existing\temp"
node scripts/check-android-update-policy.js "C:\path\to\existing\temp"
```

The UI smoke exercises the real desktop renderer and Android HTML/JS in Chromium,
including theme persistence, history navigation, literal changelogs, offline progress
reopening, and permission/retry states. Network, Android native calls, and installer
launches are fixtures; no installer runs and it is not an Android device test. The
policy check requires JDK 17+ on PATH and needs no Android SDK or network.

An optional **online** updater transport check downloads the current public Windows
release to temporary staging, verifies its GitHub SHA-256, and removes it without
launching/installing anything (allow for the full installer download size):

```powershell
node scripts/check-update-download.js "C:\path\to\existing\temp"
```

An optional online Electron smoke check exercises the real scan button, preload/IPC, download button, progress events, and bundled helper. Supply a public single-video link and an existing temporary directory (not your Downloads folder):

```powershell
npx electron scripts/smoke-public-video.js --smoke-url="https://www.linkedin.com/posts/PUBLIC-POST" --smoke-temp="C:\path\to\existing\temp"
```

The check redirects Downloads to a new temporary subfolder and removes its test files afterward. An optional `--smoke-receipt="C:\path\to\existing\temp\receipt.json"` saves a small result summary without media URLs.

## Build a Windows installer

```powershell
npm run build:win
```

The installer is written to `dist-self-contained/` by electron-builder. The helpers are placed outside the application archive at `resources/bin/` so yt-dlp and FFmpeg can run correctly after installation.

If a previous output folder is locked, use a fresh destination instead of deleting
unrelated files. The current local v2 builds use this ignored output directory:

```powershell
npm run verify:bundle
npx electron-builder --win --x64 --config.directories.output=dist-v2/updater --publish never
```

Latest updater build: `dist-v2/updater/Resource-Radar-Setup-2.0.0.exe`.
See [v2 verification results](V2_VERIFICATION.md) for checked artifacts and remaining
device-test limits. Older files directly under `dist-v2/` predate the updater.

## Android APK

The native Android project is under `android/`. It uses Android-compatible
yt-dlp/QuickJS/FFmpeg libraries instead of the Windows `.exe` helpers, saves
through Android MediaStore, and supports the same public-only direct/video/
playlist flow. Build a debug APK from that directory:

```powershell
cd android
.\gradlew.bat assembleDebug --no-daemon --console plain
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`. This is a
debug-signed local installer; a Play Store release needs a configured release
keystore and release signing policy.
