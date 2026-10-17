package com.rhinzler.resourceradar;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

/**
 * Small, bounded persistence layer for completed MediaStore downloads.
 *
 * <p>Only rows that have already been published by {@link MediaOutput.PendingFile}
 * are recorded.  The WebView never supplies a URI to this class: callers open an
 * entry by its opaque id, and the URI is read back from this store before it is
 * validated with ContentResolver.</p>
 */
final class DownloadHistoryStore {
    private static final String PREFERENCES = "resource_radar_download_history";
    private static final String RECORDS_KEY = "records";
    private static final int MAX_RECORDS = 100;

    private final android.content.SharedPreferences preferences;
    private final ContentResolver resolver;
    private final Object lock = new Object();

    DownloadHistoryStore(Context context) {
        Context app = context == null ? null : context.getApplicationContext();
        if (app == null) {
            throw new IllegalArgumentException("context is required");
        }
        preferences = app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        resolver = app.getContentResolver();
    }

    /** Records a row only after its pending MediaStore state has been published. */
    String record(Uri uri, String displayName, String mimeType, long size, String relativePath)
            throws JSONException {
        if (!isSafeContentUri(uri)) {
            throw new JSONException("The completed download URI is invalid.");
        }
        JSONObject record = new JSONObject();
        put(record, "id", UUID.randomUUID().toString());
        put(record, "uri", uri.toString());
        put(record, "displayName", boundedText(displayName, "Downloaded file", 160));
        put(record, "mimeType", boundedText(mimeType, "application/octet-stream", 160));
        put(record, "size", Math.max(0L, size));
        put(record, "completedAt", System.currentTimeMillis());
        put(record, "relativePath", boundedText(relativePath, "Downloads/", 240));

        synchronized (lock) {
            JSONArray records = readRecords();
            JSONArray updated = new JSONArray();
            updated.put(record);
            for (int index = 0; index < records.length() && updated.length() < MAX_RECORDS; index++) {
                JSONObject existing = records.optJSONObject(index);
                if (existing != null && isValidRecord(existing)) {
                    updated.put(existing);
                }
            }
            persist(updated);
        }
        return record.optString("id", "");
    }

    JSONObject list() throws JSONException {
        synchronized (lock) {
            JSONArray records = readRecords();
            JSONArray result = new JSONArray();
            for (int index = 0; index < records.length(); index++) {
                JSONObject record = records.optJSONObject(index);
                if (record == null || !isValidRecord(record)) {
                    continue;
                }
                JSONObject copy = new JSONObject(record.toString());
                // The renderer only needs the opaque id.  Keep content URIs on the
                // native side so a page cannot turn history into a URI oracle.
                copy.remove("uri");
                put(copy, "available", isAvailable(Uri.parse(record.optString("uri", ""))));
                result.put(copy);
            }
            JSONObject response = new JSONObject();
            put(response, "ok", true);
            put(response, "downloads", result);
            put(response, "count", result.length());
            return response;
        }
    }

    void clear() throws JSONException {
        synchronized (lock) {
            persist(new JSONArray());
        }
    }

    JSONObject open(String id) {
        String requestedId = id == null ? "" : id.trim();
        if (requestedId.isEmpty() || requestedId.length() > 128) {
            return error("INVALID_DOWNLOAD_ID", "The download history entry is invalid.");
        }
        JSONObject record;
        synchronized (lock) {
            record = find(requestedId);
        }
        if (record == null) {
            return error("DOWNLOAD_NOT_FOUND", "That download is no longer in history.");
        }
        Uri uri = Uri.parse(record.optString("uri", ""));
        if (!isSafeContentUri(uri)) {
            return error("INVALID_DOWNLOAD_URI", "The saved download URI is not safe to open.");
        }
        if (!isAvailable(uri)) {
            return error("DOWNLOAD_UNAVAILABLE", "The downloaded file is no longer available.");
        }
        JSONObject result = new JSONObject();
        put(result, "ok", true);
        put(result, "id", requestedId);
        put(result, "uri", uri.toString());
        put(result, "displayName", record.optString("displayName", "Downloaded file"));
        put(result, "message", "The downloaded file was opened.");
        return result;
    }

    private JSONObject find(String id) {
        JSONArray records;
        try {
            records = readRecords();
        } catch (JSONException exception) {
            return null;
        }
        for (int index = 0; index < records.length(); index++) {
            JSONObject record = records.optJSONObject(index);
            if (record != null && id.equals(record.optString("id", "")) && isValidRecord(record)) {
                return record;
            }
        }
        return null;
    }

    private JSONArray readRecords() throws JSONException {
        String raw = preferences.getString(RECORDS_KEY, "[]");
        if (TextUtils.isEmpty(raw)) {
            return new JSONArray();
        }
        try {
            JSONArray records = new JSONArray(raw);
            return records.length() > MAX_RECORDS
                    ? trimRecords(records)
                    : records;
        } catch (JSONException exception) {
            // A corrupt preference must not make the history bridge unusable.  The
            // next successful write replaces it with a clean bounded array.
            return new JSONArray();
        }
    }

    private static JSONArray trimRecords(JSONArray records) throws JSONException {
        JSONArray trimmed = new JSONArray();
        for (int index = 0; index < records.length() && index < MAX_RECORDS; index++) {
            trimmed.put(records.opt(index));
        }
        return trimmed;
    }

    private void persist(JSONArray records) throws JSONException {
        if (!preferences.edit().putString(RECORDS_KEY, records.toString()).commit()) {
            throw new JSONException("The download history could not be saved.");
        }
    }

    private boolean isAvailable(Uri uri) {
        if (!isSafeContentUri(uri)) {
            return false;
        }
        try (Cursor cursor = resolver.query(uri,
                new String[]{MediaStore.MediaColumns.IS_PENDING}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) {
                return false;
            }
            int pendingIndex = cursor.getColumnIndex(MediaStore.MediaColumns.IS_PENDING);
            return pendingIndex < 0 || cursor.isNull(pendingIndex) || cursor.getInt(pendingIndex) == 0;
        } catch (RuntimeException exception) {
            return false;
        }
    }

    private static boolean isValidRecord(JSONObject record) {
        String id = record.optString("id", "").trim();
        String rawUri = record.optString("uri", "").trim();
        return !id.isEmpty() && id.length() <= 128 && isSafeContentUri(Uri.parse(rawUri));
    }

    private static boolean isSafeContentUri(Uri uri) {
        return uri != null
                && "content".equalsIgnoreCase(uri.getScheme())
                && !TextUtils.isEmpty(uri.getAuthority())
                && uri.getUserInfo() == null
                && uri.getPath() != null
                && !uri.getPath().contains("..")
                && uri.getQuery() == null
                && uri.getFragment() == null;
    }

    private static String boundedText(String value, String fallback, int maximum) {
        String result = value == null ? "" : value.trim();
        if (result.isEmpty()) result = fallback;
        return result.length() > maximum ? result.substring(0, maximum).trim() : result;
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
            object.put(key, value == null ? JSONObject.NULL : value);
        } catch (JSONException exception) {
            throw new IllegalStateException("Could not build download history response.", exception);
        }
    }
}
