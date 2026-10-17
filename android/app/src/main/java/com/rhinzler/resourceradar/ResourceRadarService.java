package com.rhinzler.resourceradar;

import org.json.JSONObject;

/**
 * Native service seam for the WebView bridge.
 *
 * <p>Implementations should keep public-only URL policy and Android storage policy in
 * this layer. JSON is used at the seam so the UI can keep the same method names and
 * payload shapes as the desktop preload bridge without adding a UI dependency.</p>
 */
public interface ResourceRadarService {
    JSONObject scanPage(String rawUrl);

    JSONObject inspectPlatform(String rawUrl);

    JSONObject getMediaToolStatus();

    JSONObject downloadResources(String resourcesJson, DownloadEventSink eventSink);

    JSONObject downloadPlatformMedia(String requestJson, DownloadEventSink eventSink);

    JSONObject cancelDownloads(String jobId);

    JSONObject openDownloads(String destination);

    JSONObject getDownloadHistory();

    JSONObject clearDownloadHistory();

    JSONObject openDownload(String historyId);

    JSONObject checkForUpdates();

    JSONObject getUpdateStatus();

    JSONObject downloadUpdate();

    JSONObject openUpdateInstallSettings();

    interface DownloadEventSink {
        void emit(JSONObject event);
    }
}
