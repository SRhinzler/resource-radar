package com.rhinzler.resourceradar;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.TextUtils;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLException;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.regex.Pattern;

import kotlin.Unit;
import kotlin.jvm.functions.Function3;
import okhttp3.Call;
import okhttp3.HttpUrl;

/**
 * Native Resource Radar backend.
 *
 * <p>All public methods retain the synchronous JSON seam used by the WebView, but
 * page/media inspection runs in the caller's worker and accepted downloads return a
 * job id immediately.  A service instance owns its HTTP client, executors, staging
 * files, MediaStore pending rows, and yt-dlp process ids; {@link #close()} cancels
 * every one of those resources.</p>
 */
public final class NativeResourceService implements ResourceRadarService, AutoCloseable {
    private static final String BUNDLED_YTDLP_VERSION = "2026.08.19";
    static final int MAX_CANDIDATES = 80;
    static final int MAX_PLAYLIST_ITEMS = 100;
    static final int MAX_DIRECT_ACTIVE = 3;
    private static final long PLAYLIST_CACHE_MILLIS = TimeUnit.MINUTES.toMillis(10);
    private static final Pattern HTTP_URL = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);
    private static final Set<String> VIDEO_EXTENSIONS;
    private static final Set<String> DOCUMENT_EXTENSIONS;

    static {
        Set<String> video = new HashSet<>();
        Collections.addAll(video, "mp4", "m4v", "mov", "webm", "mkv", "avi", "flv", "ogv", "ts");
        VIDEO_EXTENSIONS = Collections.unmodifiableSet(video);
        Set<String> docs = new HashSet<>();
        Collections.addAll(docs, "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt",
                "rtf", "odt", "ods", "odp", "epub", "zip", "7z", "tar", "gz", "bz2");
        DOCUMENT_EXTENSIONS = Collections.unmodifiableSet(docs);
    }

    private final Context context;
    private final PublicHttp http;
    private final ExecutorService downloadExecutor;
    private final ExecutorService coordinatorExecutor;
    private final ConcurrentHashMap<String, DownloadJob> jobs = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CachedPlaylist> playlistCache = new ConcurrentHashMap<>();
    private final Set<String> ownedProcessIds = ConcurrentHashMap.newKeySet();
    private final AtomicReference<DownloadJob> activeJob = new AtomicReference<>();
    private final String initializationError;
    private volatile boolean closed;

    public NativeResourceService(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context is required");
        }
        this.context = context.getApplicationContext() == null ? context : context.getApplicationContext();
        this.http = new PublicHttp();
        this.downloadExecutor = Executors.newFixedThreadPool(MAX_DIRECT_ACTIVE, runnable -> {
            Thread thread = new Thread(runnable, "resource-radar-download-queue");
            thread.setDaemon(true);
            return thread;
        });
        this.coordinatorExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "resource-radar-download-coordinator");
            thread.setDaemon(true);
            return thread;
        });

        String initFailure = null;
        try {
            // Both libraries unpack their embedded Python/FFmpeg/QuickJS assets into
            // the application's private no-backup directory.  No Termux or external
            // executable is used.
            YoutubeDL.getInstance().init(this.context);
            FFmpeg.getInstance().init(this.context);
        } catch (Throwable throwable) {
            // Keep the failure visible through getMediaToolStatus and every media
            // operation.  Returning "ready" after a failed native init is unsafe.
            initFailure = sanitizeError(throwable);
        }
        this.initializationError = initFailure;
    }

    @Override
    public JSONObject scanPage(String rawUrl) {
        if (closed) {
            return error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
        }
        try {
            PublicHttp.Page page = http.fetchPage(rawUrl);
            Document document = Jsoup.parse(page.body(), page.url().toString());
            JSONArray resources = discoverResources(document, page.url());
            JSONObject result = success("OK", "Public page scan complete.");
            put(result, "pageUrl", page.url().toString());
            put(result, "resources", resources);
            put(result, "count", resources.length());
            return result;
        } catch (PublicHttp.PublicHttpException exception) {
            return error(exception.code(), exception.getMessage());
        } catch (IOException exception) {
            return error("PAGE_FETCH_FAILED", "The public page could not be fetched safely.");
        } catch (RuntimeException exception) {
            return error("PAGE_SCAN_FAILED", "The public page could not be scanned.");
        }
    }

    @Override
    public JSONObject inspectPlatform(String rawUrl) {
        if (closed) {
            return error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
        }
        JSONObject readiness = mediaReadinessError();
        if (readiness != null) {
            return readiness;
        }
        try {
            PlatformUrl platformUrl = canonicalPlatformUrl(rawUrl);
            if (isYoutubePlaylist(platformUrl.url)) {
                PlaylistPlan plan = buildPlaylistPlan(platformUrl.url.toString(), null, null);
                playlistCache.put(platformUrl.url.toString(), new CachedPlaylist(plan));
                return playlistResponse(plan);
            }
            JSONObject metadata = fetchSingleMetadata(platformUrl.url.toString(), null, null);
            JSONObject media = normalizeMedia(metadata, platformUrl.platform, platformUrl.url.toString());
            JSONObject result = success("OK", "Platform media metadata is ready.");
            put(result, "mode", "video");
            put(result, "url", platformUrl.url.toString());
            put(result, "media", media);
            return result;
        } catch (PublicHttp.PublicHttpException exception) {
            return error(exception.code(), exception.getMessage());
        } catch (JobCanceledException exception) {
            return error("CANCELED", "The metadata request was canceled.");
        } catch (Exception exception) {
            return error(mediaErrorCode(exception), safeOperationMessage(exception, "Platform metadata could not be read."));
        }
    }

    @Override
    public JSONObject getMediaToolStatus() {
        JSONObject result;
        if (closed) {
            result = error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
            put(result, "ready", false);
            put(result, "available", false);
            return result;
        }
        if (initializationError != null) {
            result = error("MEDIA_TOOL_INIT_FAILED", "The embedded media tools could not be initialized: " + initializationError);
            put(result, "ready", false);
            put(result, "available", false);
            put(result, "platform", "android");
            return result;
        }
        result = success("READY", "Embedded yt-dlp, QuickJS, and FFmpeg are ready.");
        put(result, "ready", true);
        put(result, "available", true);
        put(result, "platform", "android");
        put(result, "embedded", true);
        put(result, "termux", false);
        put(result, "ytDlpVersion", BUNDLED_YTDLP_VERSION);
        return result;
    }

    @Override
    public JSONObject downloadResources(String resourcesJson, ResourceRadarService.DownloadEventSink eventSink) {
        if (closed) {
            return error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
        }
        if (TextUtils.isEmpty(resourcesJson)) {
            return error("INVALID_RESOURCES", "Select at least one resource.");
        }
        final List<DirectItem> items;
        try {
            JSONArray array = new JSONArray(resourcesJson);
            if (array.length() == 0) {
                return error("INVALID_RESOURCES", "Select at least one resource.");
            }
            if (array.length() > MAX_CANDIDATES) {
                return error("TOO_MANY_RESOURCES", "Select no more than " + MAX_CANDIDATES + " resources.");
            }
            items = parseDirectItems(array);
        } catch (PublicHttp.PublicHttpException exception) {
            return error(exception.code(), exception.getMessage());
        } catch (Exception exception) {
            return error("INVALID_RESOURCES", "The selected resources could not be read.");
        }
        if (items.isEmpty()) {
            return error("INVALID_RESOURCES", "Select at least one public HTTPS resource.");
        }
        return enqueueJob(DownloadKind.DIRECT, items, null, eventSink);
    }

    @Override
    public JSONObject downloadPlatformMedia(String requestJson, ResourceRadarService.DownloadEventSink eventSink) {
        if (closed) {
            return error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
        }
        JSONObject readiness = mediaReadinessError();
        if (readiness != null) {
            return readiness;
        }
        if (TextUtils.isEmpty(requestJson)) {
            return error("INVALID_MEDIA_REQUEST", "A public video URL is required.");
        }
        try {
            JSONObject request = new JSONObject(requestJson);
            String rawUrl = request.optString("url", "").trim();
            PlatformUrl platformUrl = canonicalPlatformUrl(rawUrl);
            boolean playlist = request.optBoolean("playlist", false) || isYoutubePlaylist(platformUrl.url);
            if (playlist && !isYoutubePlaylist(platformUrl.url)) {
                return error("INVALID_PLAYLIST", "Only YouTube list URLs can be downloaded as playlists.");
            }
            Integer maxHeight = parseMaxHeight(request.opt("maxHeight"));
            if (request.has("maxHeight") && request.opt("maxHeight") != JSONObject.NULL && maxHeight == null) {
                return error("INVALID_RESOLUTION", "The maximum resolution is invalid.");
            }
            PlatformRequest platformRequest = new PlatformRequest(platformUrl, playlist, maxHeight);
            return enqueueJob(DownloadKind.PLATFORM, platformRequest, null, eventSink);
        } catch (PublicHttp.PublicHttpException exception) {
            return error(exception.code(), exception.getMessage());
        } catch (Exception exception) {
            return error(mediaErrorCode(exception), safeOperationMessage(exception, "The video request could not be read safely."));
        }
    }

    @Override
    public JSONObject cancelDownloads(String jobId) {
        if (closed) {
            return error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
        }
        String requested = jobId == null ? "" : jobId.trim();
        DownloadJob job = jobs.get(requested);
        if (job == null || job.finished.get()) {
            JSONObject result = success("NO_ACTIVE_JOB", "There is no active download job to cancel.");
            put(result, "jobId", requested);
            put(result, "canceled", false);
            return result;
        }
        job.requestCancel();
        JSONObject result = success("CANCEL_REQUESTED", "Download cancellation was requested.");
        put(result, "jobId", requested);
        put(result, "canceled", true);
        return result;
    }

    @Override
    public JSONObject openDownloads(String destination) {
        if (closed) {
            return error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
        }
        String value = destination == null ? "downloads" : destination.trim().toLowerCase(Locale.US);
        if (!"downloads".equals(value) && !"playlist".equals(value)) {
            return error("INVALID_DESTINATION", "Only Downloads or its Playlist subfolder can be opened.");
        }
        Intent intent = new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject result = success("OPENED", "Android Downloads is open.");
            put(result, "destination", value);
            return result;
        } catch (ActivityNotFoundException exception) {
            return error("DOWNLOADS_UNAVAILABLE", "Android did not provide a Downloads view.");
        } catch (RuntimeException exception) {
            return error("DOWNLOADS_OPEN_FAILED", "Android could not open Downloads.");
        }
    }

    /** Cancels jobs, closes owned HTTP calls, and shuts down all service executors. */
    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        for (DownloadJob job : jobs.values()) {
            job.requestCancel();
        }
        for (String processId : ownedProcessIds) {
            try {
                YoutubeDL.getInstance().destroyProcessById(processId);
            } catch (Throwable ignored) {
                // A failed native initialization has no process to destroy.
            }
        }
        ownedProcessIds.clear();
        downloadExecutor.shutdownNow();
        coordinatorExecutor.shutdownNow();
        http.close();
        for (DownloadJob job : jobs.values()) {
            job.cleanupPendingAndStage();
        }
        jobs.clear();
        activeJob.set(null);
        try {
            DownloadForegroundService.stop(context);
        } catch (RuntimeException ignored) {
            // A host that has not registered the optional FGS may still close safely.
        }
    }

    private JSONObject enqueueJob(DownloadKind kind, Object payload, String ignored,
                                  ResourceRadarService.DownloadEventSink eventSink) {
        if (closed) {
            return error("SERVICE_CLOSED", "The native Resource Radar service is closed.");
        }
        DownloadJob job = new DownloadJob(UUID.randomUUID().toString(), kind, payload, eventSink);
        DownloadJob running = activeJob.get();
        if (running != null && !running.finished.get()) {
            return error("DOWNLOAD_BUSY", "Another download job is already running.");
        }
        if (!activeJob.compareAndSet(running, job)) {
            return error("DOWNLOAD_BUSY", "Another download job is already running.");
        }
        jobs.put(job.jobId, job);
        try {
            DownloadForegroundService.start(context);
        } catch (RuntimeException ignoredStartFailure) {
            // The optional service may not be registered by a host build.  The
            // download itself still runs and remains fully cancellable.
        }
        emit(job, event("job-started", job, null, -1, job.initialTotal(), null,
                null, null, null, null, "queued", null));
        try {
            job.coordinatorFuture = coordinatorExecutor.submit(() -> runJob(job));
        } catch (RuntimeException exception) {
            jobs.remove(job.jobId);
            activeJob.compareAndSet(job, null);
            DownloadForegroundService.stop(context);
            return error("DOWNLOAD_QUEUE_FAILED", "The download queue could not start.");
        }
        JSONObject result = success("JOB_ACCEPTED", "Download job started.");
        put(result, "jobId", job.jobId);
        put(result, "total", job.initialTotal());
        return result;
    }

    private void runJob(DownloadJob job) {
        try {
            if (job.kind == DownloadKind.DIRECT) {
                runDirectJob(job, castDirectItems(job.payload));
            } else {
                runPlatformJob(job, (PlatformRequest) job.payload);
            }
        } catch (JobCanceledException exception) {
            job.canceled.set(true);
        } catch (Throwable throwable) {
            job.fatalError = safeOperationMessage(throwable, "The download job failed.");
        } finally {
            job.finished.set(true);
            if (job.cancelRequested.get()) {
                job.canceled.set(true);
            }
            job.cleanupPendingAndStage();
            String status = job.canceled.get() ? "canceled"
                    : (job.fatalError == null && job.failed.get() == 0 ? "complete" : "failed");
            String completionError = job.fatalError != null ? job.fatalError
                    : (job.failed.get() > 0 ? job.failed.get() + " item(s) failed." : null);
            JSONObject completionEvent = event("job-complete", job, null, -1, job.total, null,
                    job.totalReceived(), null, null, null, status, completionError);
            put(completionEvent, "canceled", job.canceled.get());
            put(completionEvent, "failed", job.failed.get());
            emit(job, completionEvent);
            activeJob.compareAndSet(job, null);
            jobs.remove(job.jobId, job);
            try {
                DownloadForegroundService.stop(context);
            } catch (RuntimeException ignored) {
                // See enqueueJob: the foreground service is an optional host hook.
            }
        }
    }

    private static List<DirectItem> castDirectItems(Object payload) {
        @SuppressWarnings("unchecked")
        List<DirectItem> items = (List<DirectItem>) payload;
        return items;
    }

    private JSONObject mediaReadinessError() {
        if (initializationError == null) {
            return null;
        }
        return error("MEDIA_TOOL_INIT_FAILED", "The embedded media tools are unavailable: " + initializationError);
    }

    private JSONArray discoverResources(Document document, HttpUrl pageUrl) {
        LinkedHashMap<String, JSONObject> discovered = new LinkedHashMap<>();
        if (document == null || pageUrl == null) {
            return new JSONArray();
        }
        Elements elements = document.select("a[href], source[src], video[src], video[poster], embed[src], object[data], track[src]");
        for (Element element : elements) {
            if (discovered.size() >= MAX_CANDIDATES) {
                break;
            }
            String raw = element.hasAttr("href") ? element.attr("href")
                    : element.hasAttr("src") ? element.attr("src")
                    : element.hasAttr("data") ? element.attr("data")
                    : element.attr("poster");
            addResourceCandidate(discovered, raw, pageUrl, labelFor(element), sourceFor(element));
        }
        if (discovered.size() < MAX_CANDIDATES) {
            java.util.regex.Matcher matcher = HTTP_URL.matcher(document.html());
            while (matcher.find() && discovered.size() < MAX_CANDIDATES) {
                addResourceCandidate(discovered, matcher.group(), pageUrl, "Direct resource", "page");
            }
        }
        JSONArray result = new JSONArray();
        for (JSONObject value : discovered.values()) {
            result.put(value);
        }
        return result;
    }

    private void addResourceCandidate(Map<String, JSONObject> discovered, String raw,
                                      HttpUrl pageUrl, String label, String source) {
        if (raw == null || raw.trim().isEmpty() || discovered.size() >= MAX_CANDIDATES) {
            return;
        }
        String candidate = raw.trim();
        if (candidate.startsWith("//")) {
            candidate = "https:" + candidate;
        }
        HttpUrl resolved = pageUrl.resolve(candidate);
        if (resolved == null || !"https".equalsIgnoreCase(resolved.scheme())
                || !PublicHttp.isPublicUrl(resolved.toString())) {
            return;
        }
        String path = resolved.encodedPath().toLowerCase(Locale.US);
        String extension = extension(path);
        String kind;
        if (VIDEO_EXTENSIONS.contains(extension) || "video".equalsIgnoreCase(source)
                || candidate.toLowerCase(Locale.US).contains(".m3u8")) {
            kind = "video";
        } else if (DOCUMENT_EXTENSIONS.contains(extension)) {
            kind = "document";
        } else if ("download".equalsIgnoreCase(source) || "file".equalsIgnoreCase(source)) {
            kind = "file";
        } else {
            return;
        }
        String url = resolved.toString();
        if (discovered.containsKey(url)) {
            return;
        }
        JSONObject resource = new JSONObject();
        put(resource, "url", url);
        put(resource, "label", label == null || label.trim().isEmpty() ? urlLabel(resolved) : label.trim());
        put(resource, "kind", kind);
        put(resource, "source", source == null || source.isEmpty() ? "link" : source);
        if (!extension.isEmpty()) {
            put(resource, "extension", extension);
        }
        discovered.put(url, resource);
    }

    private static String labelFor(Element element) {
        if (element == null) return "Direct resource";
        String text = element.text().trim();
        if (!text.isEmpty() && text.length() <= 160) return text;
        if (element.hasAttr("aria-label")) return element.attr("aria-label").trim();
        if (element.hasAttr("title")) return element.attr("title").trim();
        return "Direct resource";
    }

    private static String sourceFor(Element element) {
        if (element == null) return "link";
        String tag = element.tagName().toLowerCase(Locale.US);
        if ("video".equals(tag) || "source".equals(tag)) return "video";
        if (element.hasAttr("download") || element.hasAttr("data-download")
                || element.attr("type").toLowerCase(Locale.US).startsWith("application/")) return "download";
        return "link";
    }

    private static String urlLabel(HttpUrl url) {
        if (url == null) return "Direct resource";
        String path = url.encodedPath();
        int slash = path.lastIndexOf('/');
        String value = slash >= 0 ? path.substring(slash + 1) : path;
        return value.isEmpty() ? "Direct resource" : value;
    }

    private static String extension(String path) {
        if (path == null) return "";
        int slash = path.lastIndexOf('/');
        int dot = path.lastIndexOf('.');
        if (dot < 0 || dot < slash || dot == path.length() - 1) return "";
        String value = path.substring(dot + 1).toLowerCase(Locale.US);
        return value.length() <= 12 ? value : "";
    }

    private List<DirectItem> parseDirectItems(JSONArray array) throws IOException {
        List<DirectItem> items = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject object = array.optJSONObject(index);
            if (object == null) {
                throw new IOException("A selected resource is invalid.");
            }
            String rawUrl = object.optString("url", "").trim();
            HttpUrl url = PublicHttp.requirePublicHttps(rawUrl);
            String normalized = url.toString();
            if (!seen.add(normalized)) {
                continue;
            }
            String kind = object.optString("kind", "file").trim().toLowerCase(Locale.US);
            if (!"video".equals(kind) && !"document".equals(kind) && !"file".equals(kind)) {
                kind = "file";
            }
            String label = object.optString("label", "").trim();
            if (label.isEmpty()) label = urlLabel(url);
            items.add(new DirectItem("resource-" + (items.size() + 1), normalized, label, kind, items.size()));
        }
        return items;
    }

    private static Integer parseMaxHeight(Object value) {
        if (value == null || value == JSONObject.NULL || "".equals(String.valueOf(value).trim())) {
            return null;
        }
        try {
            int height = Integer.parseInt(String.valueOf(value));
            return height >= 144 && height <= 4320 ? height : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static JSONObject success(String code, String message) {
        JSONObject result = new JSONObject();
        put(result, "ok", true);
        put(result, "code", code);
        put(result, "message", message);
        return result;
    }

    private static JSONObject error(String code, String message) {
        JSONObject result = new JSONObject();
        put(result, "ok", false);
        put(result, "code", code == null ? "NATIVE_ERROR" : code);
        put(result, "message", message == null || message.trim().isEmpty() ? "The native operation failed." : message);
        return result;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value == null ? JSONObject.NULL : value);
        } catch (JSONException exception) {
            throw new IllegalStateException("Could not build native response.", exception);
        }
    }

    private PlatformUrl canonicalPlatformUrl(String rawUrl) throws IOException {
        HttpUrl initial = PublicHttp.requirePublicHttps(rawUrl);
        String host = initial.host().toLowerCase(Locale.US);
        if ("lnkd.in".equals(host) || "www.lnkd.in".equals(host)) {
            HttpUrl resolved = http.resolveRedirects(initial.toString());
            if (!isSupportedPlatformHost(resolved.host())) {
                throw new PublicHttp.PublicHttpException("The short link does not resolve to a supported public platform.", "UNSUPPORTED_PLATFORM");
            }
            return new PlatformUrl(platformForHost(resolved.host()), resolved);
        }
        if (!isSupportedPlatformHost(host)) {
            throw new PublicHttp.PublicHttpException("Only YouTube, Dailymotion, LinkedIn, and Instagram URLs are supported.", "UNSUPPORTED_PLATFORM");
        }
        return new PlatformUrl(platformForHost(host), initial);
    }

    private static boolean isSupportedPlatformHost(String host) {
        if (host == null) return false;
        String value = host.toLowerCase(Locale.US);
        return isYoutubeHost(value) || isDailymotionHost(value) || isLinkedInHost(value) || isInstagramHost(value);
    }

    private static String platformForHost(String host) {
        String value = host.toLowerCase(Locale.US);
        if (isYoutubeHost(value)) return "youtube";
        if (isDailymotionHost(value)) return "dailymotion";
        if (isLinkedInHost(value)) return "linkedin";
        return "instagram";
    }

    private static boolean isYoutubeHost(String host) {
        return "youtu.be".equals(host) || "youtube.com".equals(host)
                || "www.youtube.com".equals(host) || "m.youtube.com".equals(host)
                || "music.youtube.com".equals(host);
    }

    private static boolean isDailymotionHost(String host) {
        return "dailymotion.com".equals(host) || "www.dailymotion.com".equals(host)
                || "geo.dailymotion.com".equals(host) || "dai.ly".equals(host);
    }

    private static boolean isLinkedInHost(String host) {
        return "linkedin.com".equals(host) || "www.linkedin.com".equals(host)
                || "m.linkedin.com".equals(host) || "lnkd.in".equals(host)
                || "www.lnkd.in".equals(host);
    }

    private static boolean isInstagramHost(String host) {
        return "instagram.com".equals(host) || "www.instagram.com".equals(host)
                || "m.instagram.com".equals(host);
    }

    private static boolean isYoutubePlaylist(HttpUrl url) {
        return url != null && isYoutubeHost(url.host()) && url.queryParameter("list") != null
                && !url.queryParameter("list").trim().isEmpty();
    }

    private JSONObject fetchSingleMetadata(String rawUrl, DownloadJob job, String processIdHint)
            throws IOException, JobCanceledException {
        checkCanceled(job);
        String processId = processIdHint == null ? "metadata-" + UUID.randomUUID() : processIdHint;
        YoutubeDLRequest request = new YoutubeDLRequest(rawUrl);
        request.addOption("--ignore-config")
                .addOption("--no-playlist")
                .addOption("--dump-single-json")
                .addOption("--skip-download")
                .addOption("--no-cache-dir")
                .addOption("--no-remote-components")
                .addOption("--no-warnings")
                .addOption("--no-write-info-json")
                .addOption("--no-write-thumbnail")
                .addOption("--no-progress");
        if (job != null) {
            job.processIds.add(processId);
        }
        ownedProcessIds.add(processId);
        try {
            YoutubeDLResponse response = YoutubeDL.getInstance().execute(request, processId, false,
                    callbackFor(job, null, -1, 1, null));
            checkCanceled(job);
            JSONObject metadata = parseJsonObject(response.getOut());
            if (metadata == null) {
                throw new IOException("The media extractor returned invalid metadata.");
            }
            return metadata;
        } catch (YoutubeDL.CanceledException exception) {
            throw new JobCanceledException();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new JobCanceledException();
        } catch (YoutubeDLException exception) {
            if (job != null && job.cancelRequested.get()) throw new JobCanceledException();
            throw new IOException(safeOperationMessage(exception, "Media metadata could not be read."), exception);
        } catch (RuntimeException exception) {
            if (job != null && job.cancelRequested.get()) throw new JobCanceledException();
            throw new IOException(safeOperationMessage(exception, "Media metadata could not be read."), exception);
        } finally {
            if (job != null) {
                job.processIds.remove(processId);
            }
            ownedProcessIds.remove(processId);
        }
    }

    private static JSONObject parseJsonObject(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        try {
            return new JSONObject(value);
        } catch (JSONException ignored) {
            int start = value.indexOf('{');
            int end = value.lastIndexOf('}');
            if (start < 0 || end <= start) return null;
            try {
                return new JSONObject(value.substring(start, end + 1));
            } catch (JSONException ignoredAgain) {
                return null;
            }
        }
    }

    private JSONObject normalizeMedia(JSONObject metadata, String platform, String publicUrl) {
        JSONObject media = new JSONObject();
        put(media, "url", publicUrl);
        put(media, "platform", platform);
        put(media, "id", safeText(metadata, "id"));
        put(media, "title", safeText(metadata, "title", "Untitled video"));
        put(media, "uploader", safeText(metadata, "uploader", "channel"));
        put(media, "duration", numberOrNull(metadata, "duration"));
        put(media, "uploadDate", safeText(metadata, "upload_date"));
        JSONArray formats = new JSONArray();
        TreeSet<Integer> heights = new TreeSet<>(Collections.reverseOrder());
        JSONArray rawFormats = metadata.optJSONArray("formats");
        if (rawFormats != null) {
            for (int index = 0; index < rawFormats.length(); index++) {
                JSONObject raw = rawFormats.optJSONObject(index);
                if (raw == null) continue;
                String formatId = safeText(raw, "format_id");
                String ext = safeText(raw, "ext");
                int height = raw.optInt("height", 0);
                boolean mp4 = "mp4".equalsIgnoreCase(ext);
                boolean video = height > 0 || !isEmptyCodec(raw.optString("vcodec", ""));
                boolean audio = !isEmptyCodec(raw.optString("acodec", ""));
                // LinkedIn can report an unknown vcodec while still delivering a
                // playable MP4.  Keep all MP4 formats and every format with a known
                // video/audio dimension; only discard obvious thumbnails/images.
                if (!mp4 && !video && !audio) continue;
                JSONObject format = new JSONObject();
                put(format, "formatId", formatId);
                put(format, "ext", ext);
                put(format, "height", height > 0 ? height : JSONObject.NULL);
                put(format, "width", raw.optInt("width", 0) > 0 ? raw.optInt("width") : JSONObject.NULL);
                put(format, "fps", numberOrNull(raw, "fps"));
                put(format, "vcodec", safeText(raw, "vcodec"));
                put(format, "acodec", safeText(raw, "acodec"));
                put(format, "filesize", firstNumber(raw, "filesize", "filesize_approx"));
                put(format, "tbr", numberOrNull(raw, "tbr"));
                put(format, "protocol", safeText(raw, "protocol"));
                put(format, "hasVideo", video || mp4);
                put(format, "hasAudio", audio);
                formats.put(format);
                if (height > 0) heights.add(height);
            }
        }
        if (formats.length() == 0) {
            int height = metadata.optInt("height", 0);
            if (height > 0) heights.add(height);
        }
        JSONArray resolutions = new JSONArray();
        for (Integer height : heights) resolutions.put(height);
        put(media, "formats", formats);
        put(media, "resolutions", resolutions);
        return media;
    }

    private PlaylistPlan buildPlaylistPlan(String rawUrl, DownloadJob job, ResourceRadarService.DownloadEventSink sink)
            throws IOException, JobCanceledException {
        checkCanceled(job);
        YoutubeDLRequest request = new YoutubeDLRequest(rawUrl);
        request.addOption("--ignore-config")
                .addOption("--flat-playlist")
                .addOption("--dump-single-json")
                .addOption("--skip-download")
                .addOption("--ignore-errors")
                .addOption("--playlist-end", MAX_PLAYLIST_ITEMS)
                .addOption("--no-warnings")
                .addOption("--no-write-info-json")
                .addOption("--no-write-thumbnail")
                .addOption("--no-progress");
        String processId = "playlist-" + UUID.randomUUID();
        if (job != null) job.processIds.add(processId);
        ownedProcessIds.add(processId);
        JSONObject playlistMetadata;
        try {
            YoutubeDLResponse response = YoutubeDL.getInstance().execute(request, processId, false,
                    callbackFor(job, sink, -1, MAX_PLAYLIST_ITEMS, "playlist-scan-progress"));
            checkCanceled(job);
            playlistMetadata = parseJsonObject(response.getOut());
            if (playlistMetadata == null) throw new IOException("The playlist extractor returned invalid metadata.");
        } catch (YoutubeDL.CanceledException exception) {
            throw new JobCanceledException();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new JobCanceledException();
        } catch (YoutubeDLException exception) {
            if (job != null && job.cancelRequested.get()) throw new JobCanceledException();
            throw new IOException(safeOperationMessage(exception, "The playlist could not be read."), exception);
        } finally {
            if (job != null) job.processIds.remove(processId);
            ownedProcessIds.remove(processId);
        }

        String playlistTitle = safeText(playlistMetadata, "title", "YouTube playlist");
        String playlistUploader = safeText(playlistMetadata, "uploader", "channel");
        JSONArray entries = playlistMetadata.optJSONArray("entries");
        List<PlaylistItem> available = new ArrayList<>();
        List<PlaylistItem> allEntries = new ArrayList<>();
        TreeSet<Integer> playlistHeights = new TreeSet<>(Collections.reverseOrder());
        int seen = 0;
        int scanTotal = entries == null ? 0 : Math.min(entries.length(), MAX_PLAYLIST_ITEMS);
        if (entries != null) {
            for (int index = 0; index < entries.length() && seen < MAX_PLAYLIST_ITEMS; index++) {
                JSONObject entry = entries.optJSONObject(index);
                if (entry == null) continue;
                seen++;
                String id = safeText(entry, "id");
                String videoUrl = safeText(entry, "webpage_url");
                if (videoUrl.isEmpty() && !id.isEmpty()) {
                    videoUrl = "https://www.youtube.com/watch?v=" + id;
                }
                boolean unavailable = isUnavailableEntry(entry) || videoUrl.isEmpty();
                if (unavailable) {
                    // Flat-playlist entries can contain extractor-internal or
                    // signed URLs for unavailable items.  Keep only the stable
                    // public YouTube watch URL derived from the id.
                    videoUrl = id.isEmpty() ? "" : "https://www.youtube.com/watch?v=" + id;
                }
                String title = safeText(entry, "title", id.isEmpty() ? "Unavailable video" : id);
                String date = safeText(entry, "upload_date");
                PlaylistItem item = new PlaylistItem(id, videoUrl, title, date, playlistUploader, index);
                if (!unavailable) {
                    try {
                        PlatformUrl videoPlatform = canonicalPlatformUrl(videoUrl);
                        if (!"youtube".equals(videoPlatform.platform)) {
                            item.available = false;
                            item.url = id.isEmpty() ? "" : "https://www.youtube.com/watch?v=" + id;
                        } else {
                            JSONObject hydrated = fetchSingleMetadata(videoPlatform.url.toString(), job,
                                    "playlist-item-" + UUID.randomUUID());
                            addHeights(hydrated, playlistHeights);
                            item.title = safeText(hydrated, "title", item.title);
                            item.uploadDate = safeText(hydrated, "upload_date", item.uploadDate);
                            item.uploader = safeText(hydrated, "uploader", item.uploader);
                            item.id = safeText(hydrated, "id", item.id);
                            item.url = videoPlatform.url.toString();
                            item.available = true;
                        }
                    } catch (JobCanceledException exception) {
                        throw exception;
                    } catch (Exception exception) {
                        item.available = false;
                        item.url = id.isEmpty() ? "" : "https://www.youtube.com/watch?v=" + id;
                    }
                }
                allEntries.add(item);
                if (item.available) available.add(item);
                if (sink != null && job != null) {
                    emit(job, event("playlist-scan-progress", job, null, seen - 1, scanTotal,
                            null, null, null, null, null, "scanning", null));
                }
            }
        }
        Comparator<PlaylistItem> playlistOrder = (left, right) -> {
            int leftDate = dateValue(left.uploadDate);
            int rightDate = dateValue(right.uploadDate);
            if (leftDate == 0 && rightDate != 0) return 1;
            if (leftDate != 0 && rightDate == 0) return -1;
            if (leftDate != rightDate) return Integer.compare(leftDate, rightDate);
            return Integer.compare(left.originalIndex, right.originalIndex);
        };
        Collections.sort(allEntries, playlistOrder);
        Collections.sort(available, playlistOrder);
        int order = 1;
        for (PlaylistItem item : available) item.order = order++;
        return new PlaylistPlan(rawUrl, playlistTitle, playlistUploader, available, allEntries,
                new ArrayList<>(playlistHeights), seen);
    }

    private static boolean isUnavailableEntry(JSONObject entry) {
        String availability = safeText(entry, "availability").toLowerCase(Locale.US);
        return "private".equals(availability) || "unavailable".equals(availability)
                || "needs_auth".equals(availability) || "premium_only".equals(availability)
                || "subscriber_only".equals(availability);
    }

    private static int dateValue(String raw) {
        if (raw == null || !raw.matches("\\d{8}")) return 0;
        try { return Integer.parseInt(raw); } catch (NumberFormatException ignored) { return 0; }
    }

    private JSONObject playlistResponse(PlaylistPlan plan) {
        JSONObject result = success("OK", "Playlist sorted oldest first.");
        put(result, "mode", "playlist");
        put(result, "url", plan.url);
        put(result, "title", plan.title);
        put(result, "uploader", plan.uploader);
        put(result, "availableCount", plan.items.size());
        JSONArray entries = new JSONArray();
        for (PlaylistItem item : plan.entries) {
            JSONObject entry = new JSONObject();
            put(entry, "id", item.id);
            put(entry, "url", item.url);
            put(entry, "title", item.title);
            put(entry, "uploadDate", item.uploadDate);
            put(entry, "uploader", item.uploader);
            put(entry, "available", item.available);
            put(entry, "order", item.order);
            entries.put(entry);
        }
        put(result, "entries", entries);
        JSONArray resolutions = new JSONArray();
        for (Integer height : plan.resolutions) resolutions.put(height);
        put(result, "resolutions", resolutions);
        return result;
    }

    private static void addHeights(JSONObject metadata, Set<Integer> heights) {
        if (metadata == null || heights == null) return;
        JSONArray formats = metadata.optJSONArray("formats");
        if (formats != null) {
            for (int index = 0; index < formats.length(); index++) {
                JSONObject format = formats.optJSONObject(index);
                if (format == null) continue;
                int height = format.optInt("height", 0);
                if (height > 0 && height <= 4320) heights.add(height);
            }
        }
        int height = metadata.optInt("height", 0);
        if (height > 0 && height <= 4320) heights.add(height);
    }

    private void runDirectJob(DownloadJob job, List<DirectItem> items) throws JobCanceledException {
        job.total = items.size();
        job.stageDir = createStage(job);
        List<Future<?>> futures = new ArrayList<>();
        for (DirectItem item : items) {
            checkCanceled(job);
            futures.add(downloadExecutor.submit(() -> {
                try {
                    downloadDirectItem(job, item);
                } catch (JobCanceledException exception) {
                    throw exception;
                } catch (Throwable throwable) {
                    throw new DownloadItemException(safeOperationMessage(throwable, "The resource could not be downloaded."));
                }
                return null;
            }));
        }
        for (Future<?> future : futures) {
            try {
                future.get();
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                job.requestCancel();
                throw new JobCanceledException();
            } catch (java.util.concurrent.ExecutionException exception) {
                Throwable cause = exception.getCause();
                if (cause instanceof JobCanceledException) {
                    job.canceled.set(true);
                } else if (cause instanceof DownloadItemException) {
                    // The item already emitted its error event.  Keep processing the
                    // other direct resources so one bad URL does not lose the queue.
                } else if (job.cancelRequested.get()) {
                    job.canceled.set(true);
                } else {
                    job.fatalError = safeOperationMessage(cause, "The direct download queue failed.");
                }
            }
        }
        if (job.cancelRequested.get()) throw new JobCanceledException();
    }

    private void runPlatformJob(DownloadJob job, PlatformRequest request)
            throws JobCanceledException, IOException {
        job.stageDir = createStage(job);
        if (request.playlist) {
            PlaylistPlan plan = cachedPlaylist(request.platformUrl.url.toString());
            if (plan == null) {
                plan = buildPlaylistPlan(request.platformUrl.url.toString(), job, job.sink);
            }
            checkCanceled(job);
            job.total = plan.items.size();
            emit(job, event("playlist-ready", job, null, -1, job.total, null,
                    null, null, null, null, "ready", null));
            if (plan.items.isEmpty()) {
                job.fatalError = "No available public videos were found in this playlist.";
                return;
            }
            for (PlaylistItem item : plan.items) {
                checkCanceled(job);
                try {
                    downloadPlatformItem(job, request, item);
                } catch (JobCanceledException exception) {
                    throw exception;
                } catch (Throwable throwable) {
                    job.failed.incrementAndGet();
                    JSONObject failedEvent = event("item-failed", job, item.itemId(), item.order - 1, job.total,
                            null, null, null, null, null, "failed", safeOperationMessage(throwable, "The video could not be downloaded."));
                    put(failedEvent, "title", item.title);
                    emit(job, failedEvent);
                }
            }
        } else {
            JSONObject metadata = fetchSingleMetadata(request.platformUrl.url.toString(), job, null);
            JSONObject media = normalizeMedia(metadata, request.platformUrl.platform, request.platformUrl.url.toString());
            job.total = 1;
            PlatformItem item = new PlatformItem(
                    safeText(metadata, "id", "video-1"),
                    request.platformUrl.url.toString(),
                    safeText(metadata, "title", "video"),
                    safeText(metadata, "uploader"),
                    1
            );
            // Keep the normalized metadata in memory for diagnostics without exposing
            // any of its signed extractor URLs to the event sink.
            job.mediaMetadata = media;
            try {
                downloadPlatformItem(job, request, item);
            } catch (JobCanceledException exception) {
                throw exception;
            } catch (Throwable throwable) {
                job.failed.incrementAndGet();
                JSONObject failedEvent = event("item-failed", job, item.itemId(), 0, 1,
                        null, null, null, null, null, "failed", safeOperationMessage(throwable, "The video could not be downloaded."));
                put(failedEvent, "title", item.title);
                emit(job, failedEvent);
            }
        }
    }

    private PlaylistPlan cachedPlaylist(String url) {
        CachedPlaylist cached = playlistCache.get(url);
        if (cached == null || System.currentTimeMillis() - cached.createdAt > PLAYLIST_CACHE_MILLIS) {
            if (cached != null) playlistCache.remove(url, cached);
            return null;
        }
        return cached.plan;
    }

    private File createStage(DownloadJob job) throws JobCanceledException {
        try {
            checkCanceled(job);
            return MediaOutput.createStageDirectory(context, job.jobId);
        } catch (IOException exception) {
            throw new JobCanceledOrFailedException("The private download staging folder could not be created.", exception);
        }
    }

    private void downloadDirectItem(DownloadJob job, DirectItem item) throws IOException, JobCanceledException {
        int index = item.index;
        JSONObject startedEvent = event("item-started", job, item.itemId, index, job.total,
                null, 0L, null, null, null, "starting", null);
        put(startedEvent, "title", item.label);
        emit(job, startedEvent);
        PublicHttp.StreamResponse response = null;
        File staged = null;
        try {
            checkCanceled(job);
            response = http.openStream(item.url, job.httpTracker);
            String fileName = MediaOutput.directFileName(response.contentDisposition(), item.label,
                    response.url().toString(), response.contentType(), index + 1);
            staged = MediaOutput.uniqueStageFile(job.stageDir, fileName);
            long expected = response.contentLength() >= 0 ? response.contentLength() : -1L;
            long received = 0L;
            long startedAt = System.nanoTime();
            long lastEventAt = 0L;
            try (InputStream input = new BufferedInputStream(response.stream());
                 OutputStream output = new BufferedOutputStream(new java.io.FileOutputStream(staged), 32 * 1024)) {
                byte[] buffer = new byte[32 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    checkCanceled(job);
                    output.write(buffer, 0, count);
                    received += count;
                    long now = System.nanoTime();
                    if (lastEventAt == 0L || now - lastEventAt >= TimeUnit.MILLISECONDS.toNanos(250)) {
                        emitDirectProgress(job, item, received, expected, startedAt, "downloading");
                        lastEventAt = now;
                    }
                }
                output.flush();
            }
            checkCanceled(job);
            emitDirectProgress(job, item, received, expected, startedAt, "finalizing");
            MediaOutput.PendingFile pending = beginPending(job, fileName,
                    response.contentType(), false);
            copyStageToPending(job, item, staged, pending, received, expected, startedAt);
            if (staged.exists() && !staged.delete()) {
                // Stage cleanup is retried by the job finally block.
            }
            job.received.addAndGet(received);
            JSONObject completeEvent = event("item-complete", job, item.itemId, index, job.total,
                    expected >= 0 ? 100d : null, received, expected >= 0 ? expected : null,
                    speed(received, startedAt), expected > received && expected >= 0
                            ? Math.max(0L, (long) ((expected - received) / Math.max(1d, speed(received, startedAt)))) : null,
                    "complete", null);
            put(completeEvent, "title", item.label);
            emit(job, completeEvent);
        } catch (JobCanceledException exception) {
            throw exception;
        } catch (Throwable throwable) {
            String message = safeOperationMessage(throwable, "The resource could not be downloaded.");
            job.failed.incrementAndGet();
            JSONObject failedEvent = event("item-failed", job, item.itemId, index, job.total,
                    null, null, null, null, null, "failed", message);
            put(failedEvent, "title", item.label);
            emit(job, failedEvent);
            throw new DownloadItemException(message);
        } finally {
            if (response != null) response.close();
            if (staged != null && staged.exists()) {
                //noinspection ResultOfMethodCallIgnored
                staged.delete();
            }
        }
    }

    private void emitDirectProgress(DownloadJob job, DirectItem item, long received, long expected,
                                    long startedAt, String status) {
        Double percent = expected > 0 ? Math.min(100d, received * 100d / expected) : null;
        long bytesPerSecond = speed(received, startedAt);
        Long eta = expected > received && expected >= 0 && bytesPerSecond > 0
                ? Math.max(0L, (expected - received) / bytesPerSecond) : null;
        emit(job, event("item-progress", job, item.itemId, item.index, job.total,
                percent, received, expected >= 0 ? expected : null, bytesPerSecond, eta, status, null));
    }

    private void copyStageToPending(DownloadJob job, Object item, File staged,
        MediaOutput.PendingFile pending, long received,
                                    long expected, long startedAt) throws IOException, JobCanceledException {
        try (InputStream input = new BufferedInputStream(new FileInputStream(staged), 32 * 1024);
             OutputStream output = pending.openOutput()) {
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                checkCanceled(job);
                output.write(buffer, 0, count);
            }
            output.flush();
        } catch (Throwable throwable) {
            pending.delete();
            job.pendingRows.remove(pending);
            if (throwable instanceof JobCanceledException) throw (JobCanceledException) throwable;
            if (throwable instanceof IOException) throw (IOException) throwable;
            throw new IOException("The Android Downloads row could not be written.", throwable);
        }
        checkCanceled(job);
        pending.publish(staged.length());
        job.pendingRows.remove(pending);
    }

    private void downloadPlatformItem(DownloadJob job, PlatformRequest request, PlatformItem item)
            throws IOException, JobCanceledException {
        int index = Math.max(0, item.order - 1);
        JSONObject startedEvent = event("item-started", job, item.itemId(), index, job.total,
                null, null, null, null, null, "starting", null);
        put(startedEvent, "title", item.title);
        emit(job, startedEvent);
        String stem = MediaOutput.platformStem(item.title, item.order, request.playlist);
        String outputTemplate = new File(job.stageDir, stem + ".%(ext)s").getAbsolutePath();
        String processId = job.jobId + ":" + item.itemId();
        YoutubeDLRequest ytdlp = new YoutubeDLRequest(item.url);
        ytdlp.addOption("--ignore-config")
                .addOption("--no-playlist")
                .addOption("--newline")
                .addOption("--no-cache-dir")
                .addOption("--no-remote-components")
                .addOption("--no-warnings")
                .addOption("--no-write-info-json")
                .addOption("--no-write-thumbnail")
                .addOption("--output", outputTemplate)
                .addOption("--format", formatSelector(request.maxHeight))
                .addOption("--merge-output-format", "mp4")
                .addOption("--progress-template",
                        "download:RR_PROGRESS|status=%(progress.status)s|percent=%(progress._percent_str)s|downloaded=%(progress.downloaded_bytes)s|total=%(progress.total_bytes)s|estimate=%(progress.total_bytes_estimate)s|speed=%(progress.speed)s|eta=%(progress.eta)s|format_id=%(info.format_id)s");
        job.processIds.add(processId);
        ownedProcessIds.add(processId);
        try {
            YoutubeDLResponse response = YoutubeDL.getInstance().execute(ytdlp, processId, false,
                    callbackFor(job, null, index, job.total, null, item.itemId(), item.title));
            checkCanceled(job);
            File output = findStageOutput(job.stageDir, stem);
            if (output == null || output.length() <= 0) {
                throw new IOException("The media extractor did not produce a playable file.");
            }
            String fileName = output.getName();
            MediaOutput.PendingFile pending = beginPending(job, fileName,
                    MediaOutput.mimeForName(fileName, "video/mp4"), request.playlist);
            copyStageToPending(job, item, output, pending, output.length(), output.length(), System.nanoTime());
            long bytes = output.length();
            job.received.addAndGet(bytes);
            JSONObject completeEvent = event("item-complete", job, item.itemId(), index, job.total,
                    100d, bytes, bytes, null, null, "complete", null);
            put(completeEvent, "title", item.title);
            emit(job, completeEvent);
        } catch (YoutubeDL.CanceledException exception) {
            throw new JobCanceledException();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new JobCanceledException();
        } catch (YoutubeDLException exception) {
            if (job.cancelRequested.get()) throw new JobCanceledException();
            throw new IOException(safeOperationMessage(exception, "The media download failed."), exception);
        } catch (RuntimeException exception) {
            if (job.cancelRequested.get()) throw new JobCanceledException();
            throw new IOException(safeOperationMessage(exception, "The media download failed."), exception);
        } finally {
            job.processIds.remove(processId);
            ownedProcessIds.remove(processId);
            File output = findStageOutput(job.stageDir, stem);
            if (output != null) {
                //noinspection ResultOfMethodCallIgnored
                output.delete();
            }
        }
    }

    private static String formatSelector(Integer maxHeight) {
        // Prefer a progressive MP4 first on Android. It avoids a class of
        // platform/CDN 403s on separate adaptive streams; fall back to the
        // higher-quality video+audio merge when no progressive stream exists.
        if (maxHeight == null) return "best[ext=mp4]/bestvideo*+bestaudio/best";
        return "best[ext=mp4][height<=" + maxHeight + "]"
                + "/best[height<=" + maxHeight + "]"
                + "/bestvideo*[height<=" + maxHeight + "]+bestaudio/best";
    }

    private static File findStageOutput(File stage, String stem) {
        if (stage == null || !stage.isDirectory()) return null;
        File[] files = stage.listFiles((directory, name) -> name != null && name.startsWith(stem + ".")
                && !name.endsWith(".part") && !name.endsWith(".ytdl"));
        if (files == null || files.length == 0) return null;
        File chosen = files[0];
        for (int index = 1; index < files.length; index++) {
            if (files[index].lastModified() >= chosen.lastModified()) chosen = files[index];
        }
        return chosen;
    }

    private MediaOutput.PendingFile beginPending(DownloadJob job, String fileName,
                                                  String mime, boolean playlist) throws IOException, JobCanceledException {
        checkCanceled(job);
        MediaOutput.PendingFile pending = MediaOutput.beginPending(context, fileName, mime, playlist);
        job.pendingRows.add(pending);
        return pending;
    }

    private Function3<Float, Long, String, Unit> callbackFor(DownloadJob job,
                                                              ResourceRadarService.DownloadEventSink sink,
                                                              int index, int total, String scanType) {
        return callbackFor(job, sink, index, total, scanType, null, null);
    }

    private Function3<Float, Long, String, Unit> callbackFor(DownloadJob job,
                                                              ResourceRadarService.DownloadEventSink sink,
                                                              int index, int total, String scanType,
                                                              String itemId, String title) {
        return new Function3<Float, Long, String, Unit>() {
            @Override
            public Unit invoke(Float ignoredPercent, Long ignoredEta, String line) {
                if (job != null && job.cancelRequested.get()) {
                    return Unit.INSTANCE;
                }
                Progress progress = parseProgressLine(line);
                if (progress != null && job != null) {
                    if ("playlist-scan-progress".equals(scanType)) {
                        JSONObject scanEvent = event("playlist-scan-progress", job, null, -1, total,
                                progress.percent, progress.downloadedBytes, progress.expectedBytes,
                                progress.speedBytesPerSecond, progress.etaSeconds, progress.status, null);
                        put(scanEvent, "formatId", progress.formatId);
                        emit(job, scanEvent);
                    } else if (index >= 0) {
                        JSONObject itemEvent = event("item-progress", job, itemId == null ? "item-" + index : itemId,
                                index, total, progress.percent, progress.downloadedBytes,
                                progress.expectedBytes, progress.speedBytesPerSecond,
                                progress.etaSeconds, progress.status, null);
                        put(itemEvent, "formatId", progress.formatId);
                        emit(job, itemEvent);
                    }
                }
                return Unit.INSTANCE;
            }
        };
    }

    /**
     * Parses the explicit RR_PROGRESS template emitted by yt-dlp.  It intentionally
     * does not inspect the library's Float/Long callback values: yt-dlp emits every
     * stdout line and this parser owns the progress contract.
     */
    static Progress parseProgressLine(String line) {
        if (line == null) return null;
        String value = line.trim();
        int marker = value.indexOf("RR_PROGRESS");
        if (marker < 0) return null;
        Map<String, String> fields = new HashMap<>();
        String[] parts = value.substring(marker + "RR_PROGRESS".length()).split("\\|");
        for (String part : parts) {
            int equals = part.indexOf('=');
            if (equals <= 0) continue;
            fields.put(part.substring(0, equals).trim().toLowerCase(Locale.US),
                    part.substring(equals + 1).trim());
        }
        String status = cleanProgressText(fields.get("status"));
        Double percent = parsePercent(fields.get("percent"));
        Long downloaded = parseNumber(firstField(fields, "downloaded", "downloaded_bytes", "received_bytes"));
        Long total = parseNumber(firstField(fields, "total", "total_bytes", "expected_bytes"));
        if (total == null || total < 0) {
            total = parseNumber(firstField(fields, "estimate", "total_bytes_estimate"));
        }
        Long speed = parseRate(firstField(fields, "speed", "speed_bytes_per_second"));
        Long eta = parseNumber(firstField(fields, "eta", "eta_seconds"));
        String formatId = cleanProgressText(fields.get("format_id"));
        if (status == null && percent == null && downloaded == null && total == null
                && speed == null && eta == null && formatId == null) return null;
        return new Progress(percent, downloaded, total, speed, eta, status, formatId);
    }

    private static String firstField(Map<String, String> fields, String... names) {
        if (fields == null || names == null) return null;
        for (String name : names) {
            String value = fields.get(name);
            if (value != null && !value.trim().isEmpty()) return value;
        }
        return null;
    }

    private static String cleanProgressText(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty() || "N/A".equalsIgnoreCase(value) || "NA".equalsIgnoreCase(value)
                || "none".equalsIgnoreCase(value)) return null;
        return value;
    }

    private static Double parsePercent(String raw) {
        String value = cleanProgressText(raw);
        if (value == null) return null;
        value = value.replace("%", "").trim();
        try {
            double parsed = Double.parseDouble(value);
            return parsed >= 0d && parsed <= 100d ? parsed : null;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static Long parseNumber(String raw) {
        String value = cleanProgressText(raw);
        if (value == null) return null;
        value = value.replace(",", "").trim();
        try {
            double parsed = Double.parseDouble(value);
            if (!Double.isFinite(parsed) || parsed < 0d) return null;
            return Math.round(parsed);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static Long parseRate(String raw) {
        String value = cleanProgressText(raw);
        if (value == null) return null;
        value = value.replace("/s", "").replace("ps", "").trim();
        java.util.regex.Matcher matcher = Pattern.compile("^([0-9]+(?:\\.[0-9]+)?)\\s*([kmgt]?i?b)?$",
                Pattern.CASE_INSENSITIVE).matcher(value);
        if (!matcher.find()) return parseNumber(value);
        try {
            double amount = Double.parseDouble(matcher.group(1));
            String unit = matcher.group(2) == null ? "b" : matcher.group(2).toLowerCase(Locale.US);
            double multiplier = 1d;
            if (unit.startsWith("ki")) multiplier = 1024d;
            else if (unit.startsWith("mi")) multiplier = 1024d * 1024d;
            else if (unit.startsWith("gi")) multiplier = 1024d * 1024d * 1024d;
            else if (unit.startsWith("ti")) multiplier = 1024d * 1024d * 1024d * 1024d;
            else if (unit.startsWith("k")) multiplier = 1000d;
            else if (unit.startsWith("m")) multiplier = 1000d * 1000d;
            else if (unit.startsWith("g")) multiplier = 1000d * 1000d * 1000d;
            else if (unit.startsWith("t")) multiplier = 1000d * 1000d * 1000d * 1000d;
            return Math.round(amount * multiplier);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    static long speed(long bytes, long startedAtNanos) {
        long elapsed = System.nanoTime() - startedAtNanos;
        if (elapsed <= 0L || bytes <= 0L) return 0L;
        return Math.max(0L, Math.round(bytes * 1_000_000_000d / elapsed));
    }

    private static void checkCanceled(DownloadJob job) throws JobCanceledException {
        if (job != null && (job.cancelRequested.get() || Thread.currentThread().isInterrupted())) {
            throw new JobCanceledException();
        }
    }

    private static JSONObject event(String type, DownloadJob job, String itemId, int index, int total,
                                    Double percent, Long downloaded, Long expected, Long speed,
                                    Long eta, String status, String error) {
        JSONObject value = new JSONObject();
        put(value, "type", type);
        put(value, "jobId", job == null ? "" : job.jobId);
        put(value, "itemId", itemId);
        put(value, "index", index);
        put(value, "total", total);
        put(value, "percent", percent);
        put(value, "downloadedBytes", downloaded);
        put(value, "receivedBytes", downloaded);
        put(value, "totalBytes", expected);
        put(value, "expectedBytes", expected);
        put(value, "speedBytesPerSecond", speed);
        put(value, "etaSeconds", eta);
        put(value, "status", status);
        if (error != null && !error.trim().isEmpty()) put(value, "error", sanitizeError(error));
        return value;
    }

    private static void emit(DownloadJob job, JSONObject value) {
        if (job == null || value == null || job.sink == null) return;
        try {
            job.sink.emit(value);
        } catch (RuntimeException ignored) {
            // A disposed WebView/event bridge must never strand native workers.
        }
    }

    private static String safeText(JSONObject object, String key) {
        return safeText(object, key, "");
    }

    private static String safeText(JSONObject object, String key, String fallback) {
        if (object == null || key == null) return fallback == null ? "" : fallback;
        String value = object.optString(key, "");
        if (value == null || value.trim().isEmpty() || "null".equalsIgnoreCase(value.trim())) {
            return fallback == null ? "" : fallback;
        }
        return value.trim();
    }

    private static boolean isEmptyCodec(String codec) {
        return codec == null || codec.trim().isEmpty() || "none".equalsIgnoreCase(codec)
                || "N/A".equalsIgnoreCase(codec);
    }

    private static Object numberOrNull(JSONObject object, String key) {
        if (object == null || !object.has(key) || object.isNull(key)) return JSONObject.NULL;
        double number = object.optDouble(key, Double.NaN);
        if (!Double.isFinite(number) || number < 0d) return JSONObject.NULL;
        return number == Math.rint(number) ? (long) number : number;
    }

    private static Object firstNumber(JSONObject object, String first, String second) {
        Object value = numberOrNull(object, first);
        return value == JSONObject.NULL ? numberOrNull(object, second) : value;
    }

    private static String mediaErrorCode(Throwable throwable) {
        String message = throwable == null ? "" : String.valueOf(throwable.getMessage()).toLowerCase(Locale.US);
        if (isPublicAccessRequiredMessage(message)) return "PLATFORM_ACCESS_REQUIRED";
        if (message.contains("http error 403") || message.contains("http 403")) return "MEDIA_HTTP_403";
        if (message.contains("public address policy") || message.contains("public hostname")) return "PUBLIC_DNS_REJECTED";
        if (message.contains("not found") || message.contains("unsupported")) return "MEDIA_UNAVAILABLE";
        if (message.contains("cancel")) return "CANCELED";
        return "MEDIA_METADATA_FAILED";
    }

    private static String safeOperationMessage(Throwable throwable, String fallback) {
        if (throwable == null) return fallback;
        String raw = throwable.getMessage();
        String lower = raw == null ? "" : raw.toLowerCase(Locale.US);
        if (isPublicAccessRequiredMessage(lower)) {
            return "The platform requires sign-in or is rate-limiting public requests. Resource Radar does not use cookies or bypass sign-in; try again later or use a different public video.";
        }
        if (lower.contains("http error 403") || lower.contains("http 403")) {
            return "The platform rejected the public media request (HTTP 403). The app includes an updated extractor; try again later or use a different public video.";
        }
        if (lower.contains("public address policy") || lower.contains("public hostname")) {
            return "The platform hostname was rejected by Android's public-network safety check. Check the connection and try again.";
        }
        String value = sanitizeError(throwable);
        return value.isEmpty() ? fallback : value;
    }

    private static boolean isPublicAccessRequiredMessage(String lowerMessage) {
        if (lowerMessage == null) return false;
        return lowerMessage.contains("login required")
                || lowerMessage.contains("log in required")
                || lowerMessage.contains("rate-limit reached")
                || lowerMessage.contains("rate limit reached")
                || lowerMessage.contains("use --cookies")
                || lowerMessage.contains("cookies-from-browser")
                || lowerMessage.contains("requested content is not available");
    }

    static String sanitizeError(Throwable throwable) {
        return sanitizeError(throwable == null ? null : throwable.getMessage());
    }

    static String sanitizeError(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "The native operation failed.";
        String value = raw.replaceAll("(?i)https?://[^\\s)\\]}]+", "[url]");
        value = value.replaceAll("(?i)(token|signature|sig|oauth|cookie|authorization|key|expires|secret)=[^\\s&;]+", "$1=[redacted]");
        value = value.replaceAll("\\s+", " ").trim();
        if (value.length() > 240) value = value.substring(0, 240).trim() + "…";
        return value;
    }

    static final class Progress {
        final Double percent;
        final Long downloadedBytes;
        final Long expectedBytes;
        final Long speedBytesPerSecond;
        final Long etaSeconds;
        final String status;
        final String formatId;

        Progress(Double percent, Long downloadedBytes, Long expectedBytes,
                 Long speedBytesPerSecond, Long etaSeconds, String status, String formatId) {
            this.percent = percent;
            this.downloadedBytes = downloadedBytes;
            this.expectedBytes = expectedBytes;
            this.speedBytesPerSecond = speedBytesPerSecond;
            this.etaSeconds = etaSeconds;
            this.status = status;
            this.formatId = formatId;
        }
    }

    private enum DownloadKind { DIRECT, PLATFORM }

    private final class DownloadJob {
        final String jobId;
        final DownloadKind kind;
        final Object payload;
        final ResourceRadarService.DownloadEventSink sink;
        final AtomicBoolean cancelRequested = new AtomicBoolean();
        final AtomicBoolean canceled = new AtomicBoolean();
        final AtomicBoolean finished = new AtomicBoolean();
        final java.util.concurrent.atomic.AtomicLong received = new java.util.concurrent.atomic.AtomicLong();
        final AtomicInteger completed = new AtomicInteger();
        final AtomicInteger failed = new AtomicInteger();
        final Set<Call> calls = ConcurrentHashMap.newKeySet();
        final Set<String> processIds = ConcurrentHashMap.newKeySet();
        final Set<MediaOutput.PendingFile> pendingRows = ConcurrentHashMap.newKeySet();
        volatile File stageDir;
        volatile Future<?> coordinatorFuture;
        volatile int total;
        volatile String fatalError;
        volatile JSONObject mediaMetadata;
        final PublicHttp.CallTracker httpTracker = new PublicHttp.CallTracker() {
            @Override public void add(Call call) {
                calls.add(call);
                if (cancelRequested.get() || closed) call.cancel();
            }
            @Override public void remove(Call call) { calls.remove(call); }
        };

        DownloadJob(String jobId, DownloadKind kind, Object payload, ResourceRadarService.DownloadEventSink sink) {
            this.jobId = jobId;
            this.kind = kind;
            this.payload = payload;
            this.sink = sink;
            this.total = initialTotal();
        }

        int initialTotal() {
            if (kind == DownloadKind.DIRECT) return castDirectItems(payload).size();
            return ((PlatformRequest) payload).playlist ? 0 : 1;
        }

        long totalReceived() { return received.get(); }

        void requestCancel() {
            cancelRequested.set(true);
            for (Call call : calls) call.cancel();
            for (String processId : processIds) {
                try {
                    YoutubeDL.getInstance().destroyProcessById(processId);
                } catch (Throwable ignored) {
                    // Process cancellation remains best effort if the native runtime
                    // was unavailable during initialization.
                }
            }
        }

        void cleanupPendingAndStage() {
            for (MediaOutput.PendingFile pending : pendingRows) pending.delete();
            pendingRows.clear();
            MediaOutput.deleteStage(stageDir);
        }
    }

    private static final class DirectItem {
        final String itemId;
        final String url;
        final String label;
        final String kind;
        final int index;
        DirectItem(String itemId, String url, String label, String kind, int index) {
            this.itemId = itemId;
            this.url = url;
            this.label = label;
            this.kind = kind;
            this.index = index;
        }
    }

    private static final class PlatformUrl {
        final String platform;
        final HttpUrl url;
        PlatformUrl(String platform, HttpUrl url) { this.platform = platform; this.url = url; }
    }

    private static final class PlatformRequest {
        final PlatformUrl platformUrl;
        final boolean playlist;
        final Integer maxHeight;
        PlatformRequest(PlatformUrl url, boolean playlist, Integer maxHeight) {
            this.platformUrl = url;
            this.playlist = playlist;
            this.maxHeight = maxHeight;
        }
    }

    private static class PlatformItem {
        String id;
        String url;
        String title;
        String uploader;
        int order;
        PlatformItem(String id, String url, String title, String uploader, int order) {
            this.id = id;
            this.url = url;
            this.title = title;
            this.uploader = uploader;
            this.order = order;
        }
        String itemId() { return "video-" + order; }
    }

    private static final class PlaylistItem extends PlatformItem {
        String uploadDate;
        boolean available;
        final int originalIndex;
        PlaylistItem(String id, String url, String title, String date, String uploader, int index) {
            super(id, url, title, uploader, 0);
            this.uploadDate = date;
            this.originalIndex = index;
        }
    }

    private static final class PlaylistPlan {
        final String url;
        final String title;
        final String uploader;
        final List<PlaylistItem> items;
        final List<PlaylistItem> entries;
        final List<Integer> resolutions;
        final int scanned;
        PlaylistPlan(String url, String title, String uploader, List<PlaylistItem> items,
                     List<PlaylistItem> entries, List<Integer> resolutions, int scanned) {
            this.url = url;
            this.title = title;
            this.uploader = uploader;
            this.items = items;
            this.entries = entries;
            this.resolutions = resolutions;
            this.scanned = scanned;
        }
    }

    private static final class CachedPlaylist {
        final PlaylistPlan plan;
        final long createdAt = System.currentTimeMillis();
        CachedPlaylist(PlaylistPlan plan) { this.plan = plan; }
    }

    private static class JobCanceledException extends IOException { }

    private static final class JobCanceledOrFailedException extends RuntimeException {
        JobCanceledOrFailedException(String message, Throwable cause) { super(message, cause); }
    }

    private static final class DownloadItemException extends IOException {
        DownloadItemException(String message) { super(message); }
    }
}
