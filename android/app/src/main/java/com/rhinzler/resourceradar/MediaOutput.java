package com.rhinzler.resourceradar;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.TextUtils;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Storage and filename policy for Resource Radar downloads.
 *
 * <p>Files are first written to a private, per-job staging directory.  A completed
 * file is then copied into a MediaStore Downloads row marked {@code IS_PENDING}; the
 * row is made visible only after the copy succeeds.  Any failed/cancelled row is
 * deleted, so the public Downloads collection never contains a half-written file.</p>
 */
public final class MediaOutput {
    private static final int MAX_NAME_LENGTH = 120;
    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u001f\\u007f]");
    private static final Pattern ILLEGAL = Pattern.compile("[\\\\/:*?\"<>|]");
    private static final Pattern BRACKET_ID = Pattern.compile("\\s+\\[[A-Za-z0-9_-]{6,}\\](?=\\s*$)");
    private static final Pattern CONTENT_DISPOSITION_NAME = Pattern.compile(
            "(?i)(?:^|;)\\s*(?:filename\\*|filename)\\s*=\\s*(?:UTF-8''|\\\")?([^;\\\"]+)");
    private static final Object MEDIASTORE_INSERT_LOCK = new Object();
    private static final Set<String> RESERVED_MEDIA_NAMES = new HashSet<>();

    private MediaOutput() {
    }

    /** Creates a private stage directory whose name cannot escape the cache root. */
    public static File createStageDirectory(Context context, String jobId) throws IOException {
        if (context == null) {
            throw new IOException("Android storage is unavailable.");
        }
        File root = new File(context.getCacheDir(), "resource-radar/jobs");
        String safeJob = sanitizeComponent(jobId, "job");
        File stage = new File(root, safeJob);
        if (!stage.exists() && !stage.mkdirs()) {
            throw new IOException("The private download staging folder could not be created.");
        }
        if (!stage.isDirectory()) {
            throw new IOException("The private download staging path is not a folder.");
        }
        return stage;
    }

    /** Returns a collision-safe private stage file name. */
    public static File uniqueStageFile(File stageDirectory, String requestedName) throws IOException {
        if (stageDirectory == null || !stageDirectory.isDirectory()) {
            throw new IOException("The private download staging folder is unavailable.");
        }
        String clean = sanitizeFileName(requestedName, "resource.bin");
        int suffix = 1;
        while (suffix < 10000) {
            String candidateName = suffix == 1 ? clean : addSuffix(clean, suffix);
            File candidate = new File(stageDirectory, candidateName);
            // Reserve the name before the concurrent worker starts streaming. The
            // reservation is the destination itself; FileOutputStream may safely
            // reopen it and write the actual bytes afterward.
            if (candidate.createNewFile()) {
                return candidate;
            }
            suffix++;
        }
        throw new IOException("Could not reserve a unique staging filename.");
    }

    /** Deletes a completed or partially downloaded private stage tree. */
    public static void deleteStage(File stageDirectory) {
        if (stageDirectory == null || !stageDirectory.exists()) {
            return;
        }
        File[] children = stageDirectory.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) {
                    deleteStage(child);
                } else {
                    //noinspection ResultOfMethodCallIgnored
                    child.delete();
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        stageDirectory.delete();
    }

    /**
     * Removes path separators, control characters, reserved DOS names, and trailing
     * dots/spaces.  This is intentionally static/package-visible for deterministic
     * filename tests.
     */
    static String sanitizeFileName(String rawName, String fallback) {
        String value = rawName == null ? "" : rawName.trim();
        value = CONTROL.matcher(value).replaceAll("_");
        value = ILLEGAL.matcher(value).replaceAll("_");
        value = value.replaceAll("\\s+", " ").trim();
        value = BRACKET_ID.matcher(value).replaceAll("").trim();
        while (value.endsWith(".") || value.endsWith(" ")) {
            value = value.substring(0, value.length() - 1).trim();
        }
        if (value.isEmpty() || ".".equals(value) || "..".equals(value)) {
            value = fallback == null || fallback.trim().isEmpty() ? "resource" : fallback.trim();
        }
        String stem = value;
        String extension = "";
        int dot = value.lastIndexOf('.');
        if (dot > 0 && dot < value.length() - 1) {
            stem = value.substring(0, dot);
            extension = value.substring(dot);
        }
        if (stem.equalsIgnoreCase("CON") || stem.equalsIgnoreCase("PRN")
                || stem.equalsIgnoreCase("AUX") || stem.equalsIgnoreCase("NUL")
                || stem.matches("(?i)LPT[1-9]") || stem.matches("(?i)COM[1-9]")) {
            stem = "_" + stem;
        }
        int allowedStem = Math.max(1, MAX_NAME_LENGTH - extension.length());
        if (stem.length() > allowedStem) {
            stem = stem.substring(0, allowedStem).trim();
        }
        return stem + extension;
    }

    /** Human-readable stem used by platform output templates; never includes an id token. */
    static String platformStem(String title, int order, boolean numbered) {
        String cleanTitle = sanitizeFileName(title, "video");
        int dot = cleanTitle.lastIndexOf('.');
        if (dot > 0) {
            cleanTitle = cleanTitle.substring(0, dot);
        }
        cleanTitle = sanitizeFileName(cleanTitle, "video");
        return numbered ? String.format(Locale.US, "%d. %s", Math.max(1, order), cleanTitle) : cleanTitle;
    }

    /**
     * Derives one safe, deterministic Downloads folder for a YouTube playlist.
     * The visible title makes the folder useful to a person, while the list id and
     * URL digest keep two playlists with the same title separate.
     */
    static String playlistFolderName(String playlistTitle, String playlistUrl) {
        String title = sanitizeFileName(playlistTitle, "YouTube playlist");
        title = trimComponent(title, 68);
        String listId = "";
        try {
            okhttp3.HttpUrl parsed = okhttp3.HttpUrl.parse(playlistUrl == null ? "" : playlistUrl.trim());
            if (parsed != null) listId = parsed.queryParameter("list");
        } catch (RuntimeException ignored) {
            // The platform URL has already passed the public URL policy.  Keep a
            // safe fallback if a future caller supplies a malformed value here.
        }
        listId = trimComponent(sanitizeFileName(listId, "playlist"), 32);
        String digest = shortDigest(playlistUrl);
        String value = "YouTube - " + title + " - " + listId + " - " + digest;
        return sanitizeFolderName(value, "YouTube playlist");
    }

    /** Derives a direct-download filename from Content-Disposition, hint, URL, and MIME. */
    static String directFileName(String contentDisposition, String hint, String rawUrl,
                                 String contentType, int index) {
        String candidate = contentDispositionName(contentDisposition);
        if (candidate.isEmpty()) {
            candidate = hint == null ? "" : hint.trim();
        }
        if (candidate.isEmpty()) {
            candidate = pathName(rawUrl);
        }
        if (candidate.isEmpty()) {
            candidate = "resource-" + Math.max(1, index);
        }
        candidate = sanitizeFileName(candidate, "resource-" + Math.max(1, index));
        if (!hasExtension(candidate)) {
            String extension = extensionForMime(contentType);
            if (!extension.isEmpty()) {
                candidate += extension;
            }
        }
        return sanitizeFileName(candidate, "resource-" + Math.max(1, index) + ".bin");
    }

    static String contentDispositionName(String header) {
        if (header == null || header.trim().isEmpty()) {
            return "";
        }
        Matcher matcher = CONTENT_DISPOSITION_NAME.matcher(header);
        if (!matcher.find()) {
            return "";
        }
        String value = matcher.group(1);
        if (value == null) {
            return "";
        }
        try {
            return URLDecoder.decode(value.trim(), StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return value.trim();
        }
    }

    static String extensionForMime(String contentType) {
        if (contentType == null) {
            return "";
        }
        String mime = contentType.toLowerCase(Locale.US).split(";", 2)[0].trim();
        switch (mime) {
            case "application/pdf":
                return ".pdf";
            case "application/zip":
                return ".zip";
            case "application/json":
                return ".json";
            case "text/plain":
                return ".txt";
            case "text/csv":
                return ".csv";
            case "image/jpeg":
                return ".jpg";
            case "image/png":
                return ".png";
            case "video/mp4":
                return ".mp4";
            case "video/webm":
                return ".webm";
            case "video/quicktime":
                return ".mov";
            case "audio/mpeg":
                return ".mp3";
            default:
                return "";
        }
    }

    static String mimeForName(String name, String fallback) {
        String lower = name == null ? "" : name.toLowerCase(Locale.US);
        if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".mov")) return "video/quicktime";
        if (lower.endsWith(".mkv")) return "video/x-matroska";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".doc")) return "application/msword";
        if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
        if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
        if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (lower.endsWith(".zip")) return "application/zip";
        if (lower.endsWith(".txt")) return "text/plain";
        if (lower.endsWith(".csv")) return "text/csv";
        if (fallback != null && !fallback.trim().isEmpty()) {
            return fallback.toLowerCase(Locale.US).split(";", 2)[0].trim();
        }
        return "application/octet-stream";
    }

    /**
     * Creates a pending MediaStore Downloads row.  The relative folder is a sanitized
     * path beneath Downloads; it can never introduce an absolute or traversal path. Existing rows
     * are checked under a process-wide insert lock so equal titles receive a stable
     * suffix before they become visible.
     */
    public static PendingFile beginPending(Context context, String requestedName, String mimeType,
                                            String relativeFolder) throws IOException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw new IOException("Android 10 or newer is required for safe pending Downloads output.");
        }
        Context app = context == null ? null : context.getApplicationContext();
        if (app == null) {
            throw new IOException("Android storage is unavailable.");
        }
        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String folder = sanitizeRelativeFolder(relativeFolder);
        String relativePath = Environment.DIRECTORY_DOWNLOADS + "/";
        if (!folder.isEmpty()) relativePath += folder + "/";
        String name = sanitizeFileName(requestedName, "resource.bin");
        ContentResolver resolver = app.getContentResolver();
        synchronized (MEDIASTORE_INSERT_LOCK) {
            int suffix = 1;
            while (suffix < 10000) {
                String candidateName = suffix == 1 ? name : addSuffix(name, suffix);
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, candidateName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mimeForName(candidateName, mimeType));
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri;
                try {
                    String reservationKey = relativePath + "\u0000" + candidateName;
                    if (RESERVED_MEDIA_NAMES.contains(reservationKey)) {
                        suffix++;
                        continue;
                    }
                    if (rowExists(resolver, collection, relativePath, candidateName)) {
                        suffix++;
                        continue;
                    }
                    uri = resolver.insert(collection, values);
                } catch (RuntimeException exception) {
                    throw new IOException("Android could not create the Downloads row.", exception);
                }
                if (uri == null) {
                    throw new IOException("Android could not create the Downloads row.");
                }
                RESERVED_MEDIA_NAMES.add(relativePath + "\u0000" + candidateName);
                return new PendingFile(resolver, uri, candidateName,
                        mimeForName(candidateName, mimeType), relativePath,
                        relativePath + "\u0000" + candidateName);
            }
        }
        throw new IOException("Could not reserve a collision-safe Downloads filename.");
    }

    private static boolean rowExists(ContentResolver resolver, Uri collection,
                                     String relativePath, String displayName) {
        try (Cursor cursor = resolver.query(collection,
                new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.RELATIVE_PATH + "=? AND "
                        + MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                new String[]{relativePath, displayName}, null)) {
            return cursor != null && cursor.moveToFirst();
        } catch (RuntimeException ignored) {
            // If a provider does not support the optional collision probe, its
            // insert result remains authoritative and the row is still pending.
            return false;
        }
    }

    private static String pathName(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            return "";
        }
        try {
            String path = okhttp3.HttpUrl.parse(rawUrl.trim()) == null
                    ? "" : okhttp3.HttpUrl.parse(rawUrl.trim()).encodedPath();
            int slash = path.lastIndexOf('/');
            String value = slash >= 0 ? path.substring(slash + 1) : path;
            if (value.isEmpty()) {
                return "";
            }
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return "";
        }
    }

    private static boolean hasExtension(String name) {
        if (name == null) return false;
        int dot = name.lastIndexOf('.');
        return dot > 0 && dot < name.length() - 1 && name.length() - dot <= 12;
    }

    private static String sanitizeComponent(String value, String fallback) {
        String clean = sanitizeFileName(value, fallback);
        return clean.replace('.', '_');
    }

    static String sanitizeFolderName(String rawName, String fallback) {
        if (rawName == null || rawName.trim().isEmpty()) {
            return "";
        }
        String value = sanitizeFileName(rawName, fallback);
        value = value.replaceAll("[\\\\/]+", "_").trim();
        while (value.endsWith(".") || value.endsWith(" ")) {
            value = value.substring(0, value.length() - 1).trim();
        }
        if (value.isEmpty() || ".".equals(value) || "..".equals(value)) {
            value = fallback == null || fallback.trim().isEmpty() ? "Downloads" : fallback.trim();
        }
        return trimComponent(value, MAX_NAME_LENGTH);
    }

    /** Returns the fixed Playlist parent plus one safe, title-derived child folder. */
    static String playlistRelativeFolder(String playlistFolderName) {
        String child = sanitizeFolderName(playlistFolderName, "YouTube playlist");
        return child.isEmpty() ? "Playlist" : "Playlist/" + child;
    }

    private static String sanitizeRelativeFolder(String rawName) {
        if (rawName == null || rawName.trim().isEmpty()) return "";
        StringBuilder result = new StringBuilder();
        String[] components = rawName.split("[/\\\\]+");
        for (String component : components) {
            String clean = sanitizeFolderName(component, "");
            if (clean.isEmpty()) continue;
            if (result.length() > 0) result.append('/');
            result.append(clean);
        }
        return result.toString();
    }

    private static String trimComponent(String value, int maximum) {
        String result = value == null ? "" : value.trim();
        if (result.length() <= maximum) return result;
        return result.substring(0, Math.max(1, maximum)).trim();
    }

    private static String shortDigest(String raw) {
        String value = raw == null ? "" : raw;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder(12);
            for (int index = 0; index < 6 && index < digest.length; index++) {
                builder.append(String.format(Locale.US, "%02x", digest[index] & 0xff));
            }
            return builder.toString();
        } catch (NoSuchAlgorithmException exception) {
            return Integer.toHexString(value.hashCode());
        }
    }

    private static String addSuffix(String name, int suffix) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0) {
            return name + " (" + suffix + ")";
        }
        return name.substring(0, dot) + " (" + suffix + ")" + name.substring(dot);
    }

    /** One MediaStore row held pending until a staged file has been copied successfully. */
    public static final class PendingFile {
        private final ContentResolver resolver;
        private final Uri uri;
        private final String displayName;
        private final String mimeType;
        private final String relativePath;
        private final String reservationKey;
        private boolean finalized;

        PendingFile(ContentResolver resolver, Uri uri, String displayName, String mimeType,
                    String relativePath, String reservationKey) {
            this.resolver = resolver;
            this.uri = uri;
            this.displayName = displayName;
            this.mimeType = mimeType;
            this.relativePath = relativePath;
            this.reservationKey = reservationKey;
        }

        public Uri uri() {
            return uri;
        }

        public String displayName() {
            return displayName;
        }

        public String mimeType() {
            return mimeType;
        }

        public String relativePath() {
            return relativePath;
        }

        public OutputStream openOutput() throws IOException {
            if (finalized) {
                throw new IOException("The Downloads row is already closed.");
            }
            OutputStream output = resolver.openOutputStream(uri, "w");
            if (output == null) {
                throw new IOException("Android could not open the Downloads row.");
            }
            return new BufferedOutputStream(output, 32 * 1024);
        }

        public synchronized void publish(long size) throws IOException {
            if (finalized) {
                return;
            }
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            if (size >= 0) {
                values.put(MediaStore.MediaColumns.SIZE, size);
            }
            try {
                int updated = resolver.update(uri, values, null, null);
                if (updated != 1) {
                    throw new IOException("Android could not publish the Downloads row.");
                }
                finalized = true;
                releaseReservation();
            } catch (RuntimeException exception) {
                throw new IOException("Android could not publish the Downloads row.", exception);
            }
        }

        public synchronized void delete() {
            if (finalized) {
                return;
            }
            try {
                resolver.delete(uri, null, null);
            } catch (RuntimeException ignored) {
                // Best effort cleanup.  The row remains pending and invisible if a
                // provider is temporarily unavailable.
            } finally {
                finalized = true;
                releaseReservation();
            }
        }

        private void releaseReservation() {
            if (reservationKey == null) return;
            synchronized (MEDIASTORE_INSERT_LOCK) {
                RESERVED_MEDIA_NAMES.remove(reservationKey);
            }
        }
    }
}
