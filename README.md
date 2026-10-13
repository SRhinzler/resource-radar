# Resource Radar

Resource Radar is a Windows desktop application that scans a public webpage for direct video and document links, lets the user choose what to keep, and saves the selected files in the Windows **Downloads** folder. It also uses the reviewed `yt-dlp` command-line helper to inspect and download public videos from YouTube, Dailymotion, LinkedIn, and Instagram, with a maximum-resolution selector.

## Scope and safety

- The app supports publicly reachable `http://` and `https://` pages and direct resources.
- It does not sign in, use browser cookies, bypass paywalls, defeat DRM, extract private tokens, or capture protected streams.
- JavaScript-heavy sites, HLS/DASH playlists, embedded players, and resources that require authentication may not expose a direct downloadable file. Those are intentionally reported as unsupported rather than bypassed.
- The Windows installer includes the reviewed `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, and Deno runtime in `resources/bin/`. Users do not need to install Python, Node, yt-dlp, FFmpeg, Deno, or any other helper application separately.
- YouTube playlists and courses shared as YouTube playlist URLs are inspected, sorted by upload date from oldest to newest, and downloaded one at a time into **Downloads\Playlist** with `1. `, `2. `, `3. ` prefixes. Unavailable/private entries are skipped without login attempts. A queue is limited to 100 available videos. The queue's **Open folder** button opens that subfolder.
- Platform videos use clean titles without an appended `[video-id]`: for example, `Video by theplateindia.mp4` or `Playlist\1. Introduction.mp4`. Single videos and direct resources stay in Downloads. If a title already exists, a normal `(1)`, `(2)`, etc. suffix prevents overwriting; concurrent equal-title downloads are isolated. This applies to new downloads, not previously saved files.
- LinkedIn `lnkd.in` share links are safely resolved before selecting the video extractor. Public LinkedIn videos work without login; expired links, sign-in walls, and unavailable posts remain unsupported. LinkedIn Learning courses requiring an account/subscription are not supported. A short link to another public website is scanned as that website instead.
- Multiple direct resources selected from a page download through a bounded queue with up to three active downloads at once. YouTube playlist downloads remain strictly sequential to preserve the requested oldest-first order.
- Download progress updates are emitted during transfer with byte counts, percentage when the server provides a total size, live speed, and ETA. Chunked responses without a `Content-Length` use an animated indeterminate bar while still showing downloaded bytes and speed.
- Requests are limited to public network addresses and follow only a small number of safe HTTP redirects.
- Files are written only inside the current user's Windows Downloads directory.

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

The tests cover playlist destination/order, clean media names, concurrent title collisions, direct-download worker limits, LinkedIn short-link routing, and private-redirect rejection.

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
