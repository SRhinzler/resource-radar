package com.rhinzler.resourceradar;

import android.app.Activity;
import android.text.TextUtils;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.lang.ref.WeakReference;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Asynchronous JSON boundary between the local WebView and the native service.
 *
 * <p>The JavaScript interface only accepts a fixed operation name, a bounded JSON
 * payload, and a renderer-generated request id.  The request method acknowledges
 * immediately; the service operation always runs on the executor and its result is
 * delivered to the fixed {@code resourceRadar.__receiveNativeResult} callback.
 * This is important for page scans and for downloads, whose workers must remain
 * cancellable while the WebView is responsive.</p>
 */
public final class ResourceRadarBridge implements ResourceRadarService.DownloadEventSink {
    public static final String JAVASCRIPT_INTERFACE_NAME = "AndroidResourceRadar";

    private static final String RESULT_CALLBACK = "window.resourceRadar.__receiveNativeResult";
    private static final String EVENT_CALLBACK = "resourceRadar.__receiveDownloadEvent";
    private static final int MAX_OPERATION_LENGTH = 48;
    private static final int MAX_REQUEST_ID_LENGTH = 128;
    private static final int MAX_PAYLOAD_LENGTH = 512 * 1024;
    private static final int MAX_RESPONSE_LENGTH = 2 * 1024 * 1024;
    private static final int MAX_EVENT_LENGTH = 128 * 1024;
    private static final int MAX_URL_LENGTH = 4096;
    private static final int MAX_JOB_ID_LENGTH = 160;
    private static final int MAX_HISTORY_ID_LENGTH = 128;
    private static final int MAX_DESTINATION_LENGTH = 32;
    private static final int MAX_DIRECT_RESOURCES = 80;

    private static final Set<String> ALLOWED_OPERATIONS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList(
                    "scanPage",
                    "inspectPlatform",
                    "getMediaToolStatus",
                    "downloadResources",
                    "downloadPlatformMedia",
                    "cancelDownloads",
                    "openDownloads",
                    "getDownloadHistory",
                    "clearDownloadHistory",
                    "openDownload",
                    "checkForUpdates",
                    "getUpdateStatus",
                    "downloadUpdate",
                    "openUpdateInstallSettings"
            ))
    );

    private final Activity activity;
    private final WeakReference<WebView> webViewReference;
    private final ResourceRadarService service;
    private final ExecutorService executor;
    private final ExecutorService controlExecutor;
    private final Set<String> pendingRequests = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicLong fallbackRequestSequence = new AtomicLong(0L);
    private volatile boolean eventSubscriptionRequested;

    public ResourceRadarBridge(Activity activity, WebView webView, ResourceRadarService service) {
        if (activity == null) {
            throw new IllegalArgumentException("activity is required");
        }
        if (webView == null) {
            throw new IllegalArgumentException("webView is required");
        }
        if (service == null) {
            throw new IllegalArgumentException("service is required");
        }
        this.activity = activity;
        this.webViewReference = new WeakReference<>(webView);
        this.service = service;
        this.executor = boundedExecutor(2, 14, "ResourceRadarBridge");
        // A dedicated, bounded control lane keeps cancellation available even when
        // every inspection worker and its queue are occupied.
        this.controlExecutor = boundedExecutor(1, 3, "ResourceRadarControl");
    }

    private static ExecutorService boundedExecutor(int threads, int capacity, String name) {
        return new ThreadPoolExecutor(threads, threads, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(capacity), runnable -> {
                    Thread thread = new Thread(runnable, name);
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    /**
     * Starts one allow-listed native operation and returns only an immediate
     * acknowledgement.  The actual response is sent to the fixed JavaScript
     * callback with the same request id.
     */
    @JavascriptInterface
    public String request(String operation, String requestId, String payload) {
        final String safeRequestId = normalizeRequestId(requestId);
        if (closed.get()) {
            return error("BRIDGE_CLOSED", "The native bridge is closed.", safeRequestId);
        }
        if (!isSafeOperation(operation)) {
            return error("INVALID_OPERATION", "That native operation is not available.", safeRequestId);
        }
        if (payload == null || payload.length() > MAX_PAYLOAD_LENGTH) {
            return error("PAYLOAD_TOO_LARGE", "The native request payload is too large.", safeRequestId);
        }
        if (TextUtils.isEmpty(requestId) || !requestId.equals(safeRequestId)) {
            return error("INVALID_REQUEST_ID", "The native request id is invalid.", safeRequestId);
        }
        if (!pendingRequests.add(safeRequestId)) {
            return error("DUPLICATE_REQUEST", "That native request is already in progress.", safeRequestId);
        }

        final String operationName = operation;
        final String requestPayload = payload;
        try {
            ExecutorService target = "cancelDownloads".equals(operationName) ? controlExecutor : executor;
            target.execute(() -> runOperation(operationName, safeRequestId, requestPayload));
        } catch (RuntimeException exception) {
            pendingRequests.remove(safeRequestId);
            return error("BRIDGE_BUSY", "The native request queue is full. Try again shortly.", safeRequestId);
        }
        return acknowledgement(safeRequestId);
    }

    /**
     * Registers the one fixed event callback used by the UI.  Arbitrary callback
     * names are rejected so renderer data can never become executable JavaScript.
     */
    @JavascriptInterface
    public String onDownloadEvent(String callbackName) {
        if (closed.get()) {
            return error("BRIDGE_CLOSED", "The native bridge is closed.", "subscription");
        }
        if (!EVENT_CALLBACK.equals(callbackName)) {
            return error("INVALID_EVENT_CALLBACK", "Download events must use the local Resource Radar callback.", "subscription");
        }
        eventSubscriptionRequested = true;
        return success("subscribed", true, "Download event subscription is ready.");
    }

    @Override
    public void emit(JSONObject event) {
        if (closed.get() || !eventSubscriptionRequested || event == null) {
            return;
        }
        final String payload = event.toString();
        if (payload.length() > MAX_EVENT_LENGTH) {
            return;
        }
        postJavascript("window.resourceRadar.__receiveDownloadEvent(" + JSONObject.quote(payload) + ");");
    }

    /**
     * Stops accepting work and prevents callbacks after the WebView is destroyed.
     * The backend is closed by MainActivity because it owns the backend lifecycle.
     */
    public void close() {
        if (closed.compareAndSet(false, true)) {
            eventSubscriptionRequested = false;
            executor.shutdownNow();
            controlExecutor.shutdownNow();
            pendingRequests.clear();
        }
    }

    private void runOperation(String operation, String requestId, String payload) {
        JSONObject result;
        try {
            if (closed.get()) return;
            result = dispatch(operation, payload);
            if (result == null) {
                result = errorObject("EMPTY_RESPONSE", operation + " returned no response.");
            }
        } catch (IllegalArgumentException exception) {
            result = errorObject("INVALID_REQUEST", safeMessage(exception));
        } catch (RuntimeException exception) {
            result = errorObject("NATIVE_ERROR", operation + " failed: " + safeMessage(exception));
        } catch (LinkageError error) {
            result = errorObject("NATIVE_RUNTIME_ERROR", "The bundled native runtime could not be loaded.");
        } finally {
            pendingRequests.remove(requestId);
        }
        deliverResult(requestId, result);
    }

    private JSONObject dispatch(String operation, String payload) {
        Object value = parsePayload(payload);
        switch (operation) {
            case "scanPage":
                return service.scanPage(requireBoundedString(value, "url", MAX_URL_LENGTH));
            case "inspectPlatform":
                return service.inspectPlatform(requireBoundedString(value, "url", MAX_URL_LENGTH));
            case "getMediaToolStatus":
                requireNullOrEmpty(value, "getMediaToolStatus does not accept a payload.");
                return service.getMediaToolStatus();
            case "downloadResources":
                return service.downloadResources(requireResources(value), this);
            case "downloadPlatformMedia":
                return service.downloadPlatformMedia(requireMediaRequest(value), this);
            case "cancelDownloads":
                return service.cancelDownloads(requireJobId(value));
            case "openDownloads":
                return service.openDownloads(requireDestination(value));
            case "getDownloadHistory":
                requireNullOrEmpty(value, "getDownloadHistory does not accept a payload.");
                return service.getDownloadHistory();
            case "clearDownloadHistory":
                requireNullOrEmpty(value, "clearDownloadHistory does not accept a payload.");
                return service.clearDownloadHistory();
            case "openDownload":
                return service.openDownload(requireHistoryId(value));
            case "checkForUpdates":
                requireNullOrEmpty(value, "checkForUpdates does not accept a payload.");
                return service.checkForUpdates();
            case "getUpdateStatus":
                requireNullOrEmpty(value, "getUpdateStatus does not accept a payload.");
                return service.getUpdateStatus();
            case "downloadUpdate":
                requireNullOrEmpty(value, "downloadUpdate does not accept a payload.");
                return service.downloadUpdate();
            case "openUpdateInstallSettings":
                requireNullOrEmpty(value, "openUpdateInstallSettings does not accept a payload.");
                return service.openUpdateInstallSettings();
            default:
                // request() checks this set before scheduling, but keep the dispatch
                // closed if another call path is added later.
                throw new IllegalArgumentException("That native operation is not available.");
        }
    }

    private void deliverResult(String requestId, JSONObject result) {
        if (closed.get() || result == null) {
            return;
        }
        String response = result.toString();
        if (response.length() > MAX_RESPONSE_LENGTH) {
            response = errorObject("RESPONSE_TOO_LARGE", "The native response exceeded the display limit.").toString();
        }
        // Both values are JSON quoted.  The page receives a response string and
        // parses it, so even a title or error message containing quotes cannot alter
        // the callback expression.
        postJavascript(RESULT_CALLBACK + "(" + JSONObject.quote(requestId) + "," + JSONObject.quote(response) + ");");
    }

    private void postJavascript(String script) {
        if (closed.get() || script == null) {
            return;
        }
        final WebView webView = webViewReference.get();
        if (webView == null) {
            return;
        }
        try {
            activity.runOnUiThread(() -> {
                if (closed.get()) {
                    return;
                }
                if (activity.isFinishing()
                        || (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.JELLY_BEAN_MR1
                        && activity.isDestroyed())) {
                    return;
                }
                WebView target = webViewReference.get();
                if (target == null || target.getHandler() == null) {
                    return;
                }
                try {
                    target.evaluateJavascript(script, null);
                } catch (RuntimeException ignored) {
                    // A renderer can disappear between the lifetime check and the
                    // evaluate call.  There is no safe callback after that point.
                }
            });
        } catch (RuntimeException ignored) {
            // Activity teardown can reject a queued UI runnable.
        }
    }

    private static Object parsePayload(String payload) {
        if (payload == null || payload.trim().isEmpty() || "null".equals(payload.trim())) {
            return null;
        }
        try {
            JSONTokener tokener = new JSONTokener(payload);
            Object value = tokener.nextValue();
            while (tokener.more()) {
                if (!Character.isWhitespace(tokener.next())) {
                    throw new IllegalArgumentException("The native request payload contains trailing data.");
                }
            }
            return value;
        } catch (JSONException exception) {
            throw new IllegalArgumentException("The native request payload is not valid JSON.");
        }
    }

    private static String requireResources(Object value) {
        if (!(value instanceof JSONArray)) {
            throw new IllegalArgumentException("Select at least one resource.");
        }
        JSONArray resources = (JSONArray) value;
        if (resources.length() == 0 || resources.length() > MAX_DIRECT_RESOURCES) {
            throw new IllegalArgumentException("Select between one and " + MAX_DIRECT_RESOURCES + " resources.");
        }
        for (int index = 0; index < resources.length(); index++) {
            Object item = resources.opt(index);
            if (!(item instanceof JSONObject)) {
                throw new IllegalArgumentException("The selected resources could not be read.");
            }
            JSONObject resource = (JSONObject) item;
            String url = resource.optString("url", "");
            if (!isBoundedString(url, MAX_URL_LENGTH)) {
                throw new IllegalArgumentException("A selected resource URL is invalid.");
            }
        }
        return resources.toString();
    }

    private static String requireMediaRequest(Object value) {
        if (!(value instanceof JSONObject)) {
            throw new IllegalArgumentException("A public video request is required.");
        }
        JSONObject request = (JSONObject) value;
        String url = request.optString("url", "");
        if (!isBoundedString(url, MAX_URL_LENGTH)) {
            throw new IllegalArgumentException("A public video URL is required.");
        }
        return request.toString();
    }

    private static String requireJobId(Object value) {
        if (!(value instanceof String) || !isBoundedString((String) value, MAX_JOB_ID_LENGTH)) {
            throw new IllegalArgumentException("The download job id is invalid.");
        }
        return (String) value;
    }

    private static String requireDestination(Object value) {
        if (!(value instanceof String) || !isBoundedString((String) value, MAX_DESTINATION_LENGTH)) {
            throw new IllegalArgumentException("The download destination is invalid.");
        }
        String destination = (String) value;
        if (!"downloads".equals(destination) && !"playlist".equals(destination)) {
            throw new IllegalArgumentException("Only Android Downloads destinations are allowed.");
        }
        return destination;
    }

    private static String requireHistoryId(Object value) {
        if (!(value instanceof String) || !isBoundedString((String) value, MAX_HISTORY_ID_LENGTH)) {
            throw new IllegalArgumentException("The download history id is invalid.");
        }
        return (String) value;
    }

    private static String requireBoundedString(Object value, String label, int maximum) {
        if (!(value instanceof String) || !isBoundedString((String) value, maximum)) {
            throw new IllegalArgumentException("The native " + label + " is invalid.");
        }
        return (String) value;
    }

    private static void requireNullOrEmpty(Object value, String message) {
        if (value != null) {
            throw new IllegalArgumentException(message);
        }
    }

    private static boolean isSafeOperation(String operation) {
        return operation != null
                && operation.length() <= MAX_OPERATION_LENGTH
                && ALLOWED_OPERATIONS.contains(operation);
    }

    private static boolean isBoundedString(String value, int maximum) {
        return value != null && !value.trim().isEmpty() && value.length() <= maximum;
    }

    private String normalizeRequestId(String requestId) {
        if (requestId == null || requestId.length() == 0 || requestId.length() > MAX_REQUEST_ID_LENGTH) {
            return "invalid-" + fallbackRequestSequence.incrementAndGet();
        }
        for (int index = 0; index < requestId.length(); index++) {
            char character = requestId.charAt(index);
            if (!(character == '-' || character == '_' || character == '.' || character == ':'
                    || character >= '0' && character <= '9'
                    || character >= 'A' && character <= 'Z'
                    || character >= 'a' && character <= 'z')) {
                return "invalid-" + fallbackRequestSequence.incrementAndGet();
            }
        }
        return requestId;
    }

    private static String acknowledgement(String requestId) {
        JSONObject result = new JSONObject();
        put(result, "ok", true);
        put(result, "accepted", true);
        put(result, "requestId", requestId);
        return result.toString();
    }

    private static String success(String key, Object value, String message) {
        JSONObject result = new JSONObject();
        put(result, "ok", true);
        put(result, key, value);
        put(result, "message", message);
        return result.toString();
    }

    private static String error(String code, String message, String requestId) {
        JSONObject result = errorObject(code, message);
        put(result, "requestId", requestId);
        return result.toString();
    }

    private static JSONObject errorObject(String code, String message) {
        JSONObject result = new JSONObject();
        put(result, "ok", false);
        put(result, "code", code);
        put(result, "message", message);
        return result;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException exception) {
            throw new IllegalStateException("Could not encode native response.", exception);
        }
    }

    private static String safeMessage(RuntimeException exception) {
        String message = exception.getMessage();
        return message == null || message.trim().isEmpty() ? "Unknown native error." : message;
    }
}
