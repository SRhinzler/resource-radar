# Resource Radar v2 — local verification

Verified on 2026-10-14. These are local, unpublished builds. No v2 commit, tag,
GitHub release, or asset upload was performed.

## Current installers

| Platform | Workspace-relative file | Bytes | Version |
| --- | --- | ---: | --- |
| Windows x64 | `dist-v2/updater/Resource-Radar-Setup-2.0.0.exe` | 233,624,402 | 2.0.0 |
| Android | `android/app/build/outputs/apk/debug/app-debug.apk` | 126,211,172 | name 2.0, code 2 |

SHA-256:

```text
Windows  5ceb99b47e9c4a4eb4b94cb373bac7353881b944e9254b2506aabff43a89ac51
Android  2b92861f80079842bbe54c9b8f2e919e0285fbeed60c769a0ff8c5a741b54646
```

The older installer directly under `dist-v2/` predates the hamburger/updater work.
Its unpacked output was locked; the final Windows build used the fresh `updater/`
subdirectory instead of terminating another process or deleting its files.

## Behavior implemented

- Hamburger navigation: separate Scanner, URL history, and Download history views;
  persistent Dark/Light switch; restore/open/clear history without deleting media.
- Startup and manual GitHub checks; newer-release changelog popup with Download/Close.
  Checking alone never downloads or executes an installer.
- Dismissible update progress and offline reopening without duplicate transfers.
  Windows verifies bytes/digest before installer launch; Android additionally checks
  package/version/signing identity and handles install permission/resume/retry.
- Android Back uses a lifecycle-owned AndroidX dispatcher, not a legacy override.
- Existing per-playlist folders and oldest-first sequential download behavior retained.

## Checks completed

| Check | Result |
| --- | --- |
| `npm test -- --test-reporter=spec` | 55 passed; 0 failed/skipped |
| `node scripts/check-android-update-policy.js "<existing temp>"` | 52 assertions passed against production Java policy |
| Electron `scripts/smoke-v2-ui.js --smoke-temp="<existing temp>"` | Both local renderers passed; native/network/install boundaries stubbed |
| `npm run verify:bundle` | All four pinned Windows helpers verified |
| `node android-toolchain/scripts/verify-toolchain.js` | Six toolchain metadata entries verified; not a native runtime test |
| JavaScript `node --check`; `git diff --check` | Passed |
| Windows NSIS build | Passed with Electron 37.10.3 / electron-builder 26.15.3 |
| Android assemble and full lint | Passed; lint has 0 errors and 18 warnings |
| APK `apksigner verify --verbose` | Valid APK Signature Scheme v2; one signer, debug build |
| APK manifest inspection | Correct package `com.rhinzler.resourceradar`, version, SDKs, updater components and permissions |
| Packaged content comparisons | Eight Windows runtime/UI files and four helper hashes match source; five APK UI/runtime resource hashes match source |

Windows build command (repository root):

```powershell
npx electron-builder --win --x64 --config.directories.output=dist-v2/updater --publish never
```

Final Android command (from `android/`, with the SDK environment configured):

```powershell
.\gradlew.bat :app:assembleDebug :app:lintDebug :app:testDebugUnitTest --offline --no-daemon --console plain
```

The Gradle unit-test task reports **NO-SOURCE**, not passing Android/JUnit tests.
The 52 host-JDK assertions and renderer smoke are separate checks. Missing lint and
Activity dependencies were fetched first; the final build/lint ran offline. The
Back-navigation lint error was fixed with AndroidX Activity 1.6.1, not suppressed.

## Live GitHub transport check

`node scripts/check-update-download.js "<existing temp>"` downloaded the existing
public **v1** Windows asset (233,609,751 bytes), matched GitHub's SHA-256
`91e144de1ab203204145f7f2b2ebbfe1de7e14938f016ba740aedec7fe182258`, and removed its
temporary staging. **No installer was launched.** The test uses a fixture current
version; it does not downgrade the installed app or change production versions.

This caught and verified the fix for an unreachable first IPv6/NAT64 route: the
updater now retains all validated public DNS answers for Node's IPv4/IPv6 fallback.
The real `release-assets.githubusercontent.com` redirect is permitted; private DNS
answers and foreign initial release URLs remain rejected by regression tests.

## Remaining limits and next test

- No Android device was attached (`adb devices -l` was empty). Actual DownloadManager
  completion/recovery, APK archive signer checks, content grants, system installation,
  and button/gesture Back on Android 10 and recent Android remain device-test work.
- No real Windows installer was executed by the tests. Packaging and matching source
  bytes do not establish trusted Authenticode signing or an installed-user smoke test.
- No newer public release exists yet; newer-release dialogs use fixtures. No test
  release was published just to exercise the updater.
- APK is debug-signed. Future updater APKs need a compatible signing identity and a
  greater versionCode. System approval/unknown-app permission is still required.
- Lint warnings remain visible (SDK guards, dependency updates, backup configuration,
  local WebView JavaScript, singleton-context/resource analysis). Build warnings for
  SDK XML parsing and deprecated APIs/Gradle features are not test failures.

Install v2 manually first when upgrading from v1, which has no updater. Then follow
the [Android device smoke checklist](android/README.md#repeatable-android-smoke-coverage).
Connect an Android device with USB debugging enabled to perform the remaining native
checks; do not claim those checks passed from the Chromium/JDK fixtures.
