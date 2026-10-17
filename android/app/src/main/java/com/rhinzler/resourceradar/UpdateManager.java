package com.rhinzler.resourceradar;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/** Process-wide updater. Renderer requests never carry a URL, path, URI, or download id. */
public final class UpdateManager {
    static final long MAX_APK_BYTES = 200L * 1024 * 1024;
    private static final int MAX_NOTES = 64 * 1024;
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final String CHANNEL = "resource_radar_updates";
    private static final int NOTIFICATION_ID = 0x5255;
    private static final int VERIFICATION_REVISION = 2;
    private static UpdateManager instance;
    private final Context context;
    private final SharedPreferences preferences;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private WeakReference<Activity> foreground = new WeakReference<>(null);
    private JSONObject available;
    private JSONObject active;
    private boolean checking;
    private boolean verifying;
    private boolean startingDownload;

    static synchronized UpdateManager get(Context context) {
        if (instance == null) instance = new UpdateManager(context.getApplicationContext());
        return instance;
    }

    private UpdateManager(Context context) {
        this.context = context;
        preferences = context.getSharedPreferences("resource-radar.updates.v2", Context.MODE_PRIVATE);
        // Only a successful check in this process may authorize a new download.
        // Previously approved transfers retain their separate durable release snapshot.
        preferences.edit().remove("available").apply();
        active = readSaved("active");
    }

    /** GitHub's /latest endpoint excludes drafts and prereleases; verify that again locally. */
    JSONObject checkForUpdates(PublicHttp http) throws IOException, JSONException {
        synchronized (lock) {
            if (checking) return error("UPDATE_BUSY", "An update check is already in progress.");
            checking = true;
            available = null;
        }
        try {
            PublicHttp.Page page;
            try {
                page = http.fetchUpdateRelease();
            } catch (PublicHttp.PublicHttpException exception) {
                if ("HTTP_404".equals(exception.code())) {
                    JSONObject missing = result("NO_RELEASE", "No public stable release has been published yet.");
                    put(missing, "hasUpdate", false);
                    put(missing, "downloadable", false);
                    return missing;
                }
                throw exception;
            }
            JSONObject source = new JSONObject(page.body());
            if (source.optBoolean("draft", true) || source.optBoolean("prerelease", true)) {
                throw new IOException("GitHub did not return a stable release.");
            }
            String tag = source.getString("tag_name");
            if (UpdatePolicy.parseVersion(tag) == null) {
                return error("UPDATE_VERSION_UNKNOWN", "The latest release tag cannot be compared with this Android version.");
            }
            JSONObject release = new JSONObject();
            put(release, "tagName", tag);
            put(release, "title", bounded(source.isNull("name") ? tag : source.optString("name", tag), 512));
            put(release, "body", bounded(source.isNull("body") ? "" : source.optString("body", ""), MAX_NOTES));
            JSONObject asset = selectAsset(source.optJSONArray("assets"), tag);
            put(release, "asset", asset);
            if (asset != null) {
                put(release, "assetName", asset.optString("name"));
                put(release, "assetSize", asset.optLong("size"));
                put(release, "hasDigest", !asset.optString("sha256").isEmpty());
            }
            PackageInfo installed = installedPackage();
            boolean newer = isNewer(tag, installed);
            synchronized (lock) {
                available = newer && asset != null ? copy(release) : null;
            }
            JSONObject response = result("UPDATE_CHECKED", newer
                    ? (asset == null ? "A newer release exists, but it has no supported Android APK within the 200 MiB limit."
                    : "A newer Android release is available from SRhinzler/resource-radar.")
                    : "Resource Radar " + installed.versionName + " is up to date.");
            put(response, "hasUpdate", newer);
            put(response, "downloadable", newer && asset != null);
            put(response, "release", publicRelease(release));
            put(response, "currentVersionName", installed.versionName);
            put(response, "currentVersionCode", installed.getLongVersionCode());
            return response;
        } catch (IOException | JSONException | RuntimeException exception) {
            synchronized (lock) { available = null; }
            throw exception;
        } finally {
            synchronized (lock) { checking = false; }
        }
    }

    JSONObject downloadUpdate() {
        JSONObject release;
        JSONObject asset;
        synchronized (lock) {
            try {
                if (startingDownload) return error("UPDATE_BUSY", "The Android update is already being queued.");
                recoverEnqueueLocked();
                if (checking && (active == null || "error".equals(active.optString("state")))) {
                    return error("UPDATE_BUSY", "Wait for the current update check before starting another download.");
                }
                if (active != null) {
                    String state = active.optString("state");
                    if ("ready".equals(state) || "blocked".equals(state) || "installer_opened".equals(state)) {
                        ensureVerificationReceiptLocked(installedPackage());
                        if (!isInstallableState(active.optString("state"))) {
                            startVerification();
                            return statusLocked();
                        }
                        put(active, "state", "ready");
                        save("active", active);
                        requestInstaller();
                        return statusLocked();
                    }
                    if (!"error".equals(state) || verifying) {
                        JSONObject response = statusLocked();
                        if ("verifying".equals(response.optString("state"))) startVerification();
                        return response;
                    }
                    // Retrying a failed transfer never silently substitutes metadata from a later check.
                    if (available == null) {
                        return error("NO_UPDATE_AVAILABLE", "Check for updates again before retrying the failed download.");
                    }
                    if (!sameApprovedAsset(active.optJSONObject("release"), available)) {
                        cleanupLocked();
                        available = null;
                        return error("UPDATE_SELECTION_CHANGED", "The release changed since your failed download. Check for updates to review it before downloading.");
                    }
                    // Preserve the original title, notes, URL, digest and size for this approved retry.
                    available = copy(active.optJSONObject("release"));
                    cleanupLocked();
                }
                if (available == null || !isNewer(available.optString("tagName"), installedPackage())) {
                    return error("NO_UPDATE_AVAILABLE", "Check for updates before downloading an Android release.");
                }
                release = copy(available);
                asset = release.optJSONObject("asset");
                if (!validAsset(asset, release.optString("tagName"))) {
                    return error("UPDATE_ASSET_REJECTED", "The GitHub APK did not pass native validation.");
                }
                startingDownload = true;
            } catch (IOException | RuntimeException exception) {
                return error("UPDATE_DOWNLOAD_FAILED", "Android could not read the saved update state. Check for updates again.");
            }
        }
        try {
            // DNS may take seconds. Never hold the lock used by Activity lifecycle callbacks here.
            PublicHttp.requirePublicHttps(asset.getString("url"));
            synchronized (lock) {
                DownloadManager manager = downloads();
                if (manager == null) throw new IOException("DownloadManager is unavailable.");
                File directory = context.getExternalFilesDir("updates");
                if (directory == null || (!directory.isDirectory() && !directory.mkdirs())) {
                    throw new IOException("Update storage is unavailable.");
                }
                String fileName = UUID.randomUUID().toString() + ".apk";
                File destination = new File(directory, fileName);
                active = new JSONObject();
                put(active, "release", release);
                put(active, "fileName", fileName);
                put(active, "destination", Uri.fromFile(destination).toString());
                put(active, "state", "enqueuing");
                put(active, "message", "Android is preparing the update download.");
                // Persist the destination first, so a process death between enqueue and id storage
                // can recover our own DownloadManager row instead of enqueuing a duplicate.
                save("active", active);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(asset.getString("url")))
                        .setTitle("Resource Radar " + release.optString("tagName"))
                        .setDescription("Downloading the Android update")
                        .setMimeType(APK_MIME)
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                        .setAllowedOverRoaming(false)
                        .setDestinationInExternalFilesDir(context, "updates", fileName);
                long id = manager.enqueue(request);
                put(active, "downloadId", id);
                put(active, "state", "queued");
                try { save("active", active); } catch (IOException exception) { manager.remove(id); throw exception; }
                return statusLocked();
            }
        } catch (IOException | JSONException | RuntimeException exception) {
            synchronized (lock) {
                failLocked("Android could not start the update. Check network access and available storage, then try again.");
                return error("UPDATE_DOWNLOAD_FAILED", active == null ? "The update could not start." : active.optString("message"));
            }
        } finally {
            synchronized (lock) { startingDownload = false; }
        }
    }

    JSONObject getStatus() {
        synchronized (lock) {
            try {
                recoverEnqueueLocked();
                if (active != null) {
                    JSONObject release = active.optJSONObject("release");
                    PackageInfo installed = installedPackage();
                    if (release != null && !isNewer(release.optString("tagName"), installed)) {
                        cleanupLocked();
                    } else {
                        ensureVerificationReceiptLocked(installed);
                    }
                }
                JSONObject response = statusLocked();
                if ("verifying".equals(response.optString("state"))) startVerification();
                return response;
            } catch (IOException | RuntimeException exception) {
                return error("UPDATE_STATUS_FAILED", "Android could not read the update status.");
            }
        }
    }

    /** Only the app-owned persisted download id can schedule verification. */
    void onDownloadComplete(long id) {
        synchronized (lock) {
            try {
                recoverEnqueueLocked();
                if (active != null && id > 0 && active.optLong("downloadId") == id) {
                    statusLocked(); // Re-query Android; the broadcast alone is not proof of success.
                    if (active != null && "verifying".equals(active.optString("state"))) startVerification();
                }
            } catch (IOException | RuntimeException ignored) {
                // A later foreground status read can recover the persisted record.
            }
        }
    }

    static void handleDownloadComplete(Context context, long id) {
        if (context == null || id <= 0L) return;
        get(context).onDownloadComplete(id);
    }

    /** Runs in Android's JobService, never in the receiver or UI thread. */
    void verifyCompletedDownload() {
        JSONObject job;
        synchronized (lock) {
            if (verifying || active == null || !"verifying".equals(active.optString("state"))) return;
            verifying = true;
            job = copy(active);
        }
        File staged = null;
        File verified = null;
        try {
            JSONObject release = job.getJSONObject("release");
            JSONObject asset = release.getJSONObject("asset");
            if (!validAsset(asset, release.optString("tagName"))) throw new VerificationException("The stored APK metadata is invalid.");
            long expected = asset.getLong("size");
            File directory = new File(context.getFilesDir(), "update-apk");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new VerificationException("Private update storage is unavailable.");
            verified = new File(directory, requireFileName(job));
            staged = new File(directory, verified.getName() + ".part.apk");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long received = 0;
            try (InputStream input = openVerificationSource(job, verified);
                 FileOutputStream output = new FileOutputStream(staged)) {
                if (input == null) throw new VerificationException("The downloaded APK is missing.");
                byte[] buffer = new byte[32 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("Verification was interrupted. Reopen Resource Radar to retry.");
                    received += count;
                    if (received > expected || received > MAX_APK_BYTES) throw new VerificationException("UPDATE_SIZE_MISMATCH", "The APK exceeded its declared size.");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                output.getFD().sync();
            }
            if (received != expected) throw new VerificationException("UPDATE_SIZE_MISMATCH", "The downloaded APK size does not match GitHub.");
            String expectedDigest = asset.optString("sha256");
            byte[] actualDigest = digest.digest();
            if (!UpdatePolicy.matchesSha256(expectedDigest, actualDigest)) {
                throw new VerificationException("UPDATE_DIGEST_MISMATCH", "The APK failed its GitHub SHA-256 check. Check for updates and try again.");
            }
            PackageInfo installed = installedPackage();
            PackageInfo apk = validateArchive(staged, release, installed);
            if (Thread.currentThread().isInterrupted()) throw new IOException("APK verification was interrupted.");
            synchronized (lock) {
                if (!isCurrentRecordLocked(job) || !"verifying".equals(active.optString("state"))) {
                    discardFilesLocked(job);
                    return;
                }
                if (!staged.renameTo(verified)) throw new VerificationException("The verified APK could not be saved.");
                put(active, "verificationRevision", VERIFICATION_REVISION);
                put(active, "verifiedBytes", received);
                put(active, "verifiedSha256", UpdatePolicy.hex(actualDigest));
                put(active, "verifiedArchiveName", apk.versionName);
                put(active, "verifiedArchiveCode", apk.getLongVersionCode());
                put(active, "verifiedInstalledName", installed.versionName);
                put(active, "verifiedInstalledCode", installed.getLongVersionCode());
                put(active, "verifiedInstalledSigners", currentSignerIdentity(installed));
                active.remove("failureCode");
                put(active, "state", "ready");
                put(active, "message", "The update is verified. Continue in Android's package installer.");
                save("active", active);
            }
            requestInstaller();
            notifyReady();
        } catch (IOException | JSONException | NoSuchAlgorithmException | RuntimeException exception) {
            if (staged != null) staged.delete();
            synchronized (lock) {
                if (isCurrentRecordLocked(job)) {
                    if (!Thread.currentThread().isInterrupted()) {
                        String code = exception instanceof VerificationException
                                ? ((VerificationException) exception).code : "UPDATE_VERIFICATION_FAILED";
                        failLocked(code, exception instanceof VerificationException ? exception.getMessage()
                                : "Android could not verify the update APK. Check available storage and try again.");
                    }
                    // On interruption retain any saved APK and the durable verifying state for job retry.
                } else {
                    discardFilesLocked(job);
                }
            }
        } finally {
            synchronized (lock) { verifying = false; }
        }
    }

    void attach(Activity activity) {
        synchronized (lock) {
            foreground = new WeakReference<>(activity);
            // Native recovery must not depend on the renderer polling after a missed completion broadcast.
            if (active != null) UpdateVerificationService.schedule(context);
        }
        requestInstaller();
    }

    void detach(Activity activity) {
        synchronized (lock) { if (foreground.get() == activity) foreground.clear(); }
    }

    JSONObject openInstallSettings() {
        synchronized (lock) {
            if (active == null || !"blocked".equals(active.optString("state"))) {
                return error("NO_PENDING_INSTALL", "Download an update before opening installation settings.");
            }
        }
        main.post(() -> {
            synchronized (lock) {
                Activity activity = foreground.get();
                if (!usable(activity)) return;
                try {
                    activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + context.getPackageName())));
                } catch (RuntimeException exception) {
                    setInstallMessageLocked("blocked", "Open Android Settings > Apps > Special app access > Install unknown apps > Resource Radar.");
                }
            }
        });
        return result("SETTINGS_REQUESTED", "Allow this source for Resource Radar, then return to the app.");
    }

    private void requestInstaller() {
        main.post(() -> {
            synchronized (lock) {
                Activity activity = foreground.get();
                if (!usable(activity) || active == null) return;
                if ("verifying".equals(active.optString("state"))) { startVerification(); return; }
                String state = active.optString("state");
                if (!"ready".equals(state) && !"blocked".equals(state)) return;
                try {
                    JSONObject release = active.optJSONObject("release");
                    PackageInfo installed = installedPackage();
                    if (release == null || !isNewer(release.optString("tagName"), installed)) {
                        cleanupLocked();
                        return;
                    }
                    ensureVerificationReceiptLocked(installed);
                    if (!isInstallableState(active.optString("state"))) { startVerification(); return; }
                    if (!context.getPackageManager().canRequestPackageInstalls()) {
                        put(active, "state", "blocked");
                        put(active, "message", "Allow Resource Radar in Android Settings > Install unknown apps, then return here. Your verified APK is saved.");
                        save("active", active);
                        return;
                    }
                    File file = new File(new File(context.getFilesDir(), "update-apk"), requireFileName(active));
                    if (!file.isFile()) throw new IOException("The verified update APK is missing. Check for updates and download again.");
                    Uri uri = UpdateApkProvider.uriForFile(context, file);
                    Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE).setDataAndType(uri, APK_MIME)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    intent.setClipData(ClipData.newRawUri("Resource Radar update", uri));
                    List<ResolveInfo> installers = context.getPackageManager().queryIntentActivities(intent,
                            PackageManager.MATCH_DEFAULT_ONLY | PackageManager.MATCH_SYSTEM_ONLY);
                    if (installers.isEmpty()) throw new IOException("Android did not provide a system package installer.");
                    intent.setPackage(installers.get(0).activityInfo.packageName);
                    activity.startActivity(intent);
                    put(active, "state", "installer_opened");
                    put(active, "message", "Finish installation in Android. If you canceled, choose Install again.");
                    save("active", active);
                    NotificationManager notifications = context.getSystemService(NotificationManager.class);
                    if (notifications != null) notifications.cancel(NOTIFICATION_ID);
                } catch (IOException | RuntimeException exception) {
                    // A missing installer/settings surface must not force another download of a valid APK.
                    if (active != null && isInstallableState(active.optString("state"))) {
                        setInstallMessageLocked("ready", exception instanceof IOException ? exception.getMessage()
                                : "Android could not open its package installer. Return to the update and choose Install again.");
                    }
                }
            }
        });
    }

    private JSONObject statusLocked() throws IOException {
        JSONObject response = result("UPDATE_STATUS", "No update download is active.");
        put(response, "state", "idle");
        if (active == null) return response;
        String state = active.optString("state");
        if ("error".equals(state) && active.optBoolean("cleanupPending", true)) {
            put(active, "cleanupPending", !discardFilesLocked(active));
            save("active", active);
        }
        if ("queued".equals(state) || "downloading".equals(state)) {
            try (Cursor cursor = downloads().query(new DownloadManager.Query().setFilterById(active.optLong("downloadId")))) {
                if (cursor == null || !cursor.moveToFirst()) {
                    failLocked("Android no longer has the update download. Check for updates and try again.");
                } else {
                    long received = column(cursor, DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                    long total = column(cursor, DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                    long expected = active.optJSONObject("release").optJSONObject("asset").optLong("size");
                    int status = (int) column(cursor, DownloadManager.COLUMN_STATUS);
                    if (received > expected || total > expected || received > MAX_APK_BYTES) {
                        failLocked("The update exceeded its declared size and was rejected.");
                    } else if (status == DownloadManager.STATUS_FAILED) {
                        failLocked("Android download failed (code " + column(cursor, DownloadManager.COLUMN_REASON) + "). Check network/storage and try again.");
                    } else if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        put(active, "state", "verifying");
                        put(active, "message", "Verifying the downloaded APK…");
                        save("active", active);
                    } else {
                        put(response, "downloadedBytes", Math.max(0, received));
                        put(response, "totalBytes", expected);
                        put(response, "percent", Math.min(100L, Math.max(0L, received) * 100L / expected));
                        put(active, "state", "downloading");
                        put(active, "message", status == DownloadManager.STATUS_PAUSED
                                ? "Android paused the update. It will resume when the network is available."
                                : "Downloading the Android update in the background.");
                    }
                }
            }
        }
        put(response, "state", active.optString("state"));
        put(response, "message", active.optString("message"));
        if (active.has("failureCode")) put(response, "failureCode", active.optString("failureCode"));
        put(response, "release", publicRelease(active.optJSONObject("release")));
        return response;
    }

    private void recoverEnqueueLocked() throws IOException {
        if (active == null || !"enqueuing".equals(active.optString("state"))) return;
        try (Cursor cursor = downloads().query(new DownloadManager.Query())) {
            while (cursor != null && cursor.moveToNext()) {
                String localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                if (active.optString("destination").equals(localUri)) {
                    put(active, "downloadId", column(cursor, DownloadManager.COLUMN_ID));
                    put(active, "state", "queued");
                    save("active", active);
                    return;
                }
            }
        }
        failLocked("The update was interrupted before Android queued it. Please try again.");
    }

    private void startVerification() {
        if (!verifying && active != null && "verifying".equals(active.optString("state"))) {
            if (!UpdateVerificationService.schedule(context)) {
                put(active, "message", "Android could not schedule verification yet. Reopen Resource Radar to retry using the saved APK.");
                try { save("active", active); } catch (IOException ignored) { /* Keep the durable verifying record retryable. */ }
            }
        }
    }

    private void cleanupLocked() throws IOException {
        if (active == null) return;
        invalidateReceiptLocked();
        put(active, "state", "error");
        put(active, "message", "Cleaning up the previous update. Reopen Resource Radar if Android storage is temporarily unavailable.");
        save("active", active);
        if (!discardFilesLocked(active)) {
            put(active, "cleanupPending", true);
            save("active", active);
            throw new IOException("Android could not finish cleaning up the previous update.");
        }
        save("active", null);
        active = null;
    }

    private void failLocked(String message) {
        failLocked("UPDATE_FAILED", message);
    }

    private void failLocked(String code, String message) {
        if (active == null) return;
        invalidateReceiptLocked();
        put(active, "state", "error");
        put(active, "failureCode", code);
        put(active, "message", message == null ? "The update could not be completed." : message);
        try { save("active", active); } catch (IOException ignored) { /* Deny exposure in memory even if persistence failed. */ }
        put(active, "cleanupPending", !discardFilesLocked(active));
        try { save("active", active); } catch (IOException ignored) { /* Status/resume can retry cleanup. */ }
    }

    /** Deletes only the native record's own row and fixed UUID files; never uses its destination string as a path. */
    private boolean discardFilesLocked(JSONObject record) {
        final String name;
        try { name = requireFileName(record); } catch (IOException exception) { return false; }
        boolean complete = true;
        long id = record.optLong("downloadId", -1);
        if (id > 0) {
            try {
                DownloadManager manager = downloads();
                if (manager == null) complete = false;
                else manager.remove(id);
            } catch (RuntimeException exception) { complete = false; }
        }
        File privateDirectory = new File(context.getFilesDir(), "update-apk");
        complete &= deleteManagedFile(privateDirectory, name);
        complete &= deleteManagedFile(privateDirectory, name + ".part.apk");
        complete &= deleteManagedFile(privateDirectory, name + ".part");
        try { complete &= deleteManagedFile(context.getExternalFilesDir("updates"), name); }
        catch (RuntimeException exception) { complete = false; }
        try {
            Uri uri = new Uri.Builder().scheme("content").authority(context.getPackageName() + ".updates")
                    .appendPath(name).build();
            context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (RuntimeException ignored) { /* The provider independently rejects invalidated receipts. */ }
        return complete;
    }

    private static boolean deleteManagedFile(File directory, String name) {
        if (directory == null) return false;
        try {
            File root = directory.getCanonicalFile();
            File file = new File(root, name).getCanonicalFile();
            return root.equals(file.getParentFile()) && (!file.exists() || file.delete());
        } catch (IOException | RuntimeException exception) { return false; }
    }

    private void invalidateReceiptLocked() {
        active.remove("verificationRevision");
        active.remove("verifiedBytes");
        active.remove("verifiedSha256");
        active.remove("verifiedArchiveName");
        active.remove("verifiedArchiveCode");
        active.remove("verifiedInstalledName");
        active.remove("verifiedInstalledCode");
        active.remove("verifiedInstalledSigners");
    }

    private void setInstallMessageLocked(String state, String message) {
        if (active == null) return;
        put(active, "state", state);
        put(active, "message", message);
        try { save("active", active); } catch (IOException ignored) { /* Keep the verified APK for a later retry. */ }
    }

    private void notifyReady() {
        synchronized (lock) { if (usable(foreground.get())) return; }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        try {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Resource Radar updates", NotificationManager.IMPORTANCE_DEFAULT));
            Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pending = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            manager.notify(NOTIFICATION_ID, new Notification.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("Resource Radar update ready")
                    .setContentText("Open Resource Radar to install the verified update.")
                    .setContentIntent(pending).setAutoCancel(true).build());
        } catch (RuntimeException ignored) { /* If notifications are denied, the next resume still offers installation. */ }
    }

    private JSONObject selectAsset(JSONArray assets, String tag) {
        if (assets == null) return null;
        for (int index = 0; index < assets.length(); index++) {
            JSONObject source = assets.optJSONObject(index);
            if (source == null || !"uploaded".equals(source.optString("state"))) continue;
            JSONObject asset = new JSONObject();
            put(asset, "name", source.optString("name"));
            put(asset, "url", source.optString("browser_download_url"));
            put(asset, "size", source.optLong("size", -1));
            String digest = source.isNull("digest") ? "" : source.optString("digest", "");
            if (!digest.isEmpty() && !digest.matches("(?i)sha256:[a-f0-9]{64}")) continue;
            put(asset, "sha256", digest.isEmpty() ? "" : digest.substring(7).toLowerCase(Locale.US));
            if (validAsset(asset, tag)) return asset;
        }
        return null;
    }

    private static boolean validAsset(JSONObject asset, String tag) {
        if (asset == null) return false;
        return UpdatePolicy.isReleaseAssetUrl(asset.optString("url"), tag, asset.optString("name"))
                && asset.optLong("size") > 0 && asset.optLong("size") <= MAX_APK_BYTES
                && (asset.optString("sha256").isEmpty() || asset.optString("sha256").matches("[a-f0-9]{64}"));
    }

    private PackageInfo installedPackage() throws IOException {
        try { return context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES); }
        catch (PackageManager.NameNotFoundException exception) { throw new IOException("The installed app version is unavailable."); }
    }

    private static boolean isNewer(String tag, PackageInfo installed) throws IOException {
        try {
            return UpdatePolicy.isNewer(tag, installed.versionName, installed.getLongVersionCode());
        } catch (IllegalArgumentException exception) { throw new IOException(exception.getMessage(), exception); }
    }

    private PackageInfo validateArchive(File file, JSONObject release, PackageInfo installed) throws IOException {
        PackageInfo apk = context.getPackageManager().getPackageArchiveInfo(file.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (apk == null || !context.getPackageName().equals(apk.packageName)) {
            throw new VerificationException("UPDATE_PACKAGE_MISMATCH", "The APK is not a readable Resource Radar Android package.");
        }
        UpdatePolicy.ArchiveVersionDecision version = UpdatePolicy.archiveVersionDecision(release.optString("tagName"),
                apk.versionName, apk.getLongVersionCode(), installed.versionName, installed.getLongVersionCode());
        switch (version) {
            case INVALID_VERSION:
                throw new VerificationException("UPDATE_VERSION_INVALID", "The APK version cannot be compared with the selected release.");
            case NOT_NEWER:
                throw new VerificationException("UPDATE_NOT_NEWER", "The APK must have a strictly greater versionCode and must not downgrade the installed version.");
            case RELEASE_NAME_MISMATCH:
                throw new VerificationException("UPDATE_VERSION_MISMATCH", "The APK versionName does not match the selected release tag. This APK will not be installed.");
            case RELEASE_CODE_MISMATCH:
                throw new VerificationException("UPDATE_VERSION_CODE_MISMATCH", "The APK versionCode does not match the +code advertised in the selected release tag.");
            case MATCH:
                break;
            default:
                throw new VerificationException("UPDATE_VERSION_INVALID", "The APK version was rejected by the update policy.");
        }
        SigningInfo installedSigning = installed.signingInfo;
        SigningInfo archiveSigning = apk.signingInfo;
        byte[][] installedCurrent = currentSigners(installed);
        byte[][] archiveCurrent = currentSigners(apk);
        byte[][] history = null;
        if (installedSigning != null && archiveSigning != null
                && !installedSigning.hasMultipleSigners() && !archiveSigning.hasMultipleSigners()) {
            history = certificateBytes(archiveSigning.getSigningCertificateHistory());
        }
        UpdatePolicy.SignatureDecision signing = UpdatePolicy.signatureDecision(installedCurrent, archiveCurrent, history);
        if (signing == UpdatePolicy.SignatureDecision.MISSING_SIGNERS) {
            throw new VerificationException("UPDATE_SIGNATURE_UNAVAILABLE", "Android could not verify the installed app and APK signing identities. This APK will not be installed.");
        }
        if (signing != UpdatePolicy.SignatureDecision.EXACT_MATCH && signing != UpdatePolicy.SignatureDecision.FORWARD_ROTATION) {
            throw new VerificationException("UPDATE_SIGNATURE_INCOMPATIBLE", "The APK has an incompatible signing identity and cannot update this installation. Use a release signed by the same publisher/key lineage as the installed app.");
        }
        return apk;
    }

    private static byte[][] currentSigners(PackageInfo info) {
        return info == null || info.signingInfo == null ? null : certificateBytes(info.signingInfo.getApkContentsSigners());
    }

    private static byte[][] certificateBytes(Signature[] signatures) {
        if (signatures == null || signatures.length == 0) return null;
        byte[][] certificates = new byte[signatures.length][];
        for (int index = 0; index < signatures.length; index++) {
            if (signatures[index] == null) return null;
            certificates[index] = signatures[index].toByteArray();
        }
        return certificates;
    }

    private static String currentSignerIdentity(PackageInfo info) {
        return UpdatePolicy.signerIdentity(currentSigners(info));
    }

    private InputStream openVerificationSource(JSONObject job, File savedApk) throws IOException {
        // A saved private APK can be revalidated after a policy/app identity change without re-downloading it.
        if (savedApk.isFile()) return new FileInputStream(savedApk);
        DownloadManager manager = downloads();
        long id = job.optLong("downloadId", -1);
        if (manager == null || id <= 0) throw new VerificationException("The saved update download is unavailable.");
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor == null || !cursor.moveToFirst()
                    || column(cursor, DownloadManager.COLUMN_STATUS) != DownloadManager.STATUS_SUCCESSFUL) {
                throw new VerificationException("Android did not finish the update download.");
            }
        }
        Uri source = manager.getUriForDownloadedFile(id);
        if (source == null || !"content".equals(source.getScheme()) || !"downloads".equals(source.getAuthority())) {
            throw new VerificationException("Android did not supply a valid update content URI.");
        }
        return context.getContentResolver().openInputStream(source);
    }

    private static boolean isInstallableState(String state) {
        return "ready".equals(state) || "blocked".equals(state) || "installer_opened".equals(state);
    }

    private boolean isCurrentRecordLocked(JSONObject record) {
        return active != null && record != null && active.optLong("downloadId", -1) == record.optLong("downloadId", -2)
                && active.optString("fileName").equals(record.optString("fileName"));
    }

    /** Old-policy or changed-installed-identity receipts are invalidated before any provider exposure. */
    private void ensureVerificationReceiptLocked(PackageInfo installed) throws IOException {
        if (active == null || !isInstallableState(active.optString("state"))) return;
        File file = new File(new File(context.getFilesDir(), "update-apk"), requireFileName(active));
        if (!file.isFile()) {
            failLocked("UPDATE_FILE_MISSING", "The saved APK is missing. Check for updates and download it again.");
        } else if (!receiptMatchesInstalledLocked(file, installed)) {
            invalidateReceiptLocked();
            put(active, "state", "verifying");
            put(active, "message", "Revalidating the saved APK's version and signing identity…");
            save("active", active);
        }
    }

    /** The provider rechecks this gate even if an older installer still holds a URI grant. */
    boolean canExposeVerifiedApk(File file) {
        synchronized (lock) {
            try {
                return active != null && isInstallableState(active.optString("state"))
                        && requireFileName(active).equals(file.getName())
                        && receiptMatchesInstalledLocked(file, installedPackage());
            } catch (IOException | RuntimeException exception) { return false; }
        }
    }

    private boolean receiptMatchesInstalledLocked(File file, PackageInfo installed) {
        JSONObject release = active.optJSONObject("release");
        JSONObject asset = release == null ? null : release.optJSONObject("asset");
        String signers = currentSignerIdentity(installed);
        String actualDigest = active.optString("verifiedSha256");
        return active.optInt("verificationRevision") == VERIFICATION_REVISION && asset != null
                && validAsset(asset, release.optString("tagName")) && file.isFile()
                && active.optLong("verifiedBytes", -1) == asset.optLong("size")
                && file.length() == asset.optLong("size") && actualDigest.matches("[a-f0-9]{64}")
                && (asset.optString("sha256").isEmpty() || asset.optString("sha256").equals(actualDigest))
                && active.optLong("verifiedInstalledCode", -1) == installed.getLongVersionCode()
                && active.optString("verifiedInstalledName").equals(installed.versionName)
                && !signers.isEmpty() && signers.equals(active.optString("verifiedInstalledSigners"))
                && UpdatePolicy.archiveVersionDecision(release.optString("tagName"), active.optString("verifiedArchiveName"),
                active.optLong("verifiedArchiveCode", -1), installed.versionName, installed.getLongVersionCode())
                == UpdatePolicy.ArchiveVersionDecision.MATCH;
    }

    boolean needsVerification() {
        synchronized (lock) { return active != null && "verifying".equals(active.optString("state")); }
    }

    private static boolean sameApprovedAsset(JSONObject approved, JSONObject candidate) {
        if (approved == null || candidate == null || !approved.optString("tagName").equals(candidate.optString("tagName"))) return false;
        JSONObject first = approved.optJSONObject("asset");
        JSONObject second = candidate.optJSONObject("asset");
        return validAsset(first, approved.optString("tagName")) && validAsset(second, candidate.optString("tagName"))
                && first.optString("url").equals(second.optString("url"))
                && first.optString("name").equals(second.optString("name"))
                && first.optLong("size") == second.optLong("size")
                && first.optString("sha256").equals(second.optString("sha256"));
    }

    /** Renderer-facing projection: never include internal asset URLs, digests, signatures, paths, or row IDs. */
    private static JSONObject publicRelease(JSONObject release) {
        if (release == null) return null;
        JSONObject result = new JSONObject();
        put(result, "tagName", bounded(release.optString("tagName"), 128));
        put(result, "title", bounded(release.optString("title"), 512));
        put(result, "body", bounded(release.optString("body"), MAX_NOTES));
        JSONObject asset = release.optJSONObject("asset");
        put(result, "assetName", asset == null ? "" : bounded(asset.optString("name"), 180));
        put(result, "assetSize", asset == null ? JSONObject.NULL : asset.optLong("size"));
        put(result, "hasDigest", asset != null && !asset.optString("sha256").isEmpty());
        return result;
    }

    private static final class VerificationException extends IOException {
        final String code;
        VerificationException(String message) { this("UPDATE_VERIFICATION_FAILED", message); }
        VerificationException(String code, String message) { super(message); this.code = code; }
    }

    private JSONObject readSaved(String key) {
        try {
            String raw = preferences.getString(key, "");
            return raw.isEmpty() || raw.length() > 512 * 1024 ? null : new JSONObject(raw);
        } catch (JSONException | RuntimeException exception) { return null; }
    }

    private void save(String key, JSONObject value) throws IOException {
        SharedPreferences.Editor edit = preferences.edit();
        if (value == null) edit.remove(key); else edit.putString(key, value.toString());
        if (!edit.commit()) throw new IOException("Android could not persist update state.");
    }

    private DownloadManager downloads() { return context.getSystemService(DownloadManager.class); }
    private static boolean usable(Activity activity) { return activity != null && !activity.isFinishing() && !activity.isDestroyed(); }
    private static long column(Cursor cursor, String name) { return cursor.getLong(cursor.getColumnIndexOrThrow(name)); }
    private static String requireFileName(JSONObject record) throws IOException {
        String value = record.optString("fileName");
        if (!value.matches("[a-f0-9-]{36}\\.apk")) throw new IOException("The update filename is invalid.");
        return value;
    }
    private static String bounded(String value, int limit) { return value.length() <= limit ? value : value.substring(0, limit) + "\n[Truncated]"; }
    private static JSONObject copy(JSONObject value) {
        try { return new JSONObject(value.toString()); } catch (JSONException exception) { throw new IllegalStateException(exception); }
    }
    private static JSONObject result(String code, String message) {
        JSONObject value = new JSONObject();
        put(value, "ok", true); put(value, "code", code); put(value, "message", message);
        return value;
    }
    private static JSONObject error(String code, String message) { JSONObject value = result(code, message); put(value, "ok", false); return value; }
    private static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value == null ? JSONObject.NULL : value); }
        catch (JSONException exception) { throw new IllegalStateException(exception); }
    }
}
