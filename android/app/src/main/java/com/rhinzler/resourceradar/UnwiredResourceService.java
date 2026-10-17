package com.rhinzler.resourceradar;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Honest default service for the Android shell.
 *
 * <p>It validates the public HTTPS boundary and implements the storage-safe folder
 * intent, but does not pretend that page scanning, yt-dlp, FFmpeg, or platform media
 * downloads are available. Replace this class with a native implementation when those
 * services are ready.</p>
 */
public final class UnwiredResourceService implements ResourceRadarService {
    private static final String NOT_WIRED_CODE = "NATIVE_UNWIRED";
    private final Activity activity;

    public UnwiredResourceService(Activity activity) {
        this.activity = activity;
    }

    @Override
    public JSONObject scanPage(String rawUrl) {
        JSONObject validation = validatePublicHttpsUrl(rawUrl);
        if (validation != null) {
            return validation;
        }
        return notWired(
                "scanPage",
                "Android page scanning is not wired in this shell. No page was fetched and no files were saved."
        );
    }

    @Override
    public JSONObject inspectPlatform(String rawUrl) {
        JSONObject validation = validatePublicHttpsUrl(rawUrl);
        if (validation != null) {
            return validation;
        }
        return notWired(
                "inspectPlatform",
                "Platform inspection is not wired in this shell. Platform downloads are disabled."
        );
    }

    @Override
    public JSONObject getMediaToolStatus() {
        JSONObject result = new JSONObject();
        put(result, "ok", true);
        put(result, "ready", false);
        put(result, "available", false);
        put(result, "platform", "android");
        put(result, "message", "Android media services are not wired in this shell yet.");
        put(result, "details", "A future native service may provide public-only extraction and downloads.");
        return result;
    }

    @Override
    public JSONObject downloadResources(String resourcesJson, DownloadEventSink eventSink) {
        if (TextUtils.isEmpty(resourcesJson)) {
            return error("INVALID_RESOURCES", "Select at least one resource.");
        }
        try {
            JSONArray resources = new JSONArray(resourcesJson);
            if (resources.length() == 0) {
                return error("INVALID_RESOURCES", "Select at least one resource.");
            }
        } catch (Exception exception) {
            return error("INVALID_RESOURCES", "The selected resources could not be read.");
        }
        return notWired(
                "downloadResources",
                "Direct resource downloads are not wired in this shell. No download was started."
        );
    }

    @Override
    public JSONObject downloadPlatformMedia(String requestJson, DownloadEventSink eventSink) {
        if (TextUtils.isEmpty(requestJson)) {
            return error("INVALID_MEDIA_REQUEST", "A public video URL is required.");
        }
        try {
            JSONObject request = new JSONObject(requestJson);
            JSONObject validation = validatePublicHttpsUrl(request.optString("url", ""));
            if (validation != null) {
                return validation;
            }
        } catch (Exception exception) {
            return error("INVALID_MEDIA_REQUEST", "The video request could not be read.");
        }
        return notWired(
                "downloadPlatformMedia",
                "Platform media downloads are not wired in this shell. No download was started."
        );
    }

    @Override
    public JSONObject cancelDownloads(String jobId) {
        JSONObject result = new JSONObject();
        put(result, "ok", true);
        put(result, "canceled", false);
        put(result, "jobId", jobId == null ? "" : jobId);
        put(result, "message", "There is no active Android download job to cancel.");
        return result;
    }

    @Override
    public JSONObject openDownloads(String destination) {
        String safeDestination = TextUtils.isEmpty(destination) ? "downloads" : destination;
        if (!"downloads".equals(safeDestination) && !"playlist".equals(safeDestination)) {
            return error("INVALID_DESTINATION", "Only the Downloads folder or a playlist-specific folder is allowed.");
        }

        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // The picker may ignore this provider-specific initial URI; the user still
            // chooses the final folder explicitly, so no raw filesystem path is used.
            Uri downloadsRoot = DocumentsContract.buildRootUri(
                    "com.android.providers.downloads.documents",
                    "downloads"
            );
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, downloadsRoot);
        }

        return launchFolderPicker(intent, safeDestination);
    }

    @Override
    public JSONObject getDownloadHistory() {
        return error("NATIVE_UNWIRED", "Android download history is not wired in this shell.");
    }

    @Override
    public JSONObject clearDownloadHistory() {
        return error("NATIVE_UNWIRED", "Android download history is not wired in this shell.");
    }

    @Override
    public JSONObject openDownload(String historyId) {
        return error("NATIVE_UNWIRED", "Android download history is not wired in this shell.");
    }

    @Override
    public JSONObject checkForUpdates() {
        return error("NATIVE_UNWIRED", "Android update checking is not wired in this shell.");
    }

    @Override
    public JSONObject getUpdateStatus() {
        return error("NATIVE_UNWIRED", "Android update status is not wired in this shell.");
    }

    @Override
    public JSONObject downloadUpdate() {
        return error("NATIVE_UNWIRED", "Android update downloads are not wired in this shell.");
    }

    @Override
    public JSONObject openUpdateInstallSettings() {
        return error("NATIVE_UNWIRED", "Android update installation settings are not wired in this shell.");
    }

    private JSONObject launchFolderPicker(Intent intent, String destination) {
        AtomicReference<JSONObject> response = new AtomicReference<>();
        Runnable launch = () -> {
            try {
                activity.startActivity(intent);
                JSONObject result = new JSONObject();
                put(result, "ok", true);
                put(result, "destination", destination);
                put(result, "message", "Choose the Downloads folder in Android's folder picker.");
                response.set(result);
            } catch (ActivityNotFoundException exception) {
                response.set(error("FOLDER_PICKER_UNAVAILABLE", "Android did not provide a folder picker."));
            } catch (RuntimeException exception) {
                response.set(error("FOLDER_PICKER_FAILED", "The Downloads folder picker could not be opened."));
            }
        };

        if (Looper.myLooper() == Looper.getMainLooper()) {
            launch.run();
            return response.get();
        }

        CountDownLatch latch = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            try {
                launch.run();
            } finally {
                latch.countDown();
            }
        });
        try {
            if (!latch.await(2, TimeUnit.SECONDS)) {
                return error("FOLDER_PICKER_TIMEOUT", "The Downloads folder picker did not start in time.");
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return error("FOLDER_PICKER_INTERRUPTED", "The Downloads folder picker request was interrupted.");
        }
        return response.get() == null
                ? error("FOLDER_PICKER_FAILED", "The Downloads folder picker could not be opened.")
                : response.get();
    }

    private static JSONObject validatePublicHttpsUrl(String rawUrl) {
        if (TextUtils.isEmpty(rawUrl) || rawUrl.trim().isEmpty()) {
            return error("INVALID_URL", "Enter a public HTTPS URL first.");
        }
        Uri uri = Uri.parse(rawUrl.trim());
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(scheme) || TextUtils.isEmpty(host) || uri.getUserInfo() != null) {
            return error("INVALID_URL", "Only public HTTPS URLs without embedded credentials are supported.");
        }
        String normalizedHost = host.toLowerCase(Locale.US);
        if (isLocalHost(normalizedHost)) {
            return error("PRIVATE_URL", "Local and private network addresses are not supported.");
        }
        return null;
    }

    private static boolean isLocalHost(String host) {
        return "localhost".equals(host)
                || host.endsWith(".local")
                || "::1".equals(host)
                || host.startsWith("127.")
                || host.startsWith("10.")
                || host.startsWith("192.168.")
                || host.startsWith("169.254.")
                || host.matches("172\\.(1[6-9]|2[0-9]|3[0-1])\\..*");
    }

    private static JSONObject notWired(String operation, String message) {
        JSONObject result = error(NOT_WIRED_CODE, message);
        put(result, "operation", operation);
        put(result, "wired", false);
        return result;
    }

    private static JSONObject error(String code, String message) {
        JSONObject result = new JSONObject();
        put(result, "ok", false);
        put(result, "code", code);
        put(result, "message", message);
        return result;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (Exception exception) {
            throw new IllegalStateException("Could not build native response.", exception);
        }
    }
}
