package com.rhinzler.resourceradar;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Completes native verification and opens the package installer after DownloadManager finishes. */
public final class UpdateDownloadReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
            return;
        }
        long downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
        if (downloadId <= 0L) return;
        final PendingResult pendingResult = goAsync();
        Thread worker = new Thread(() -> {
            try {
                UpdateManager.handleDownloadComplete(context, downloadId);
            } finally {
                pendingResult.finish();
            }
        }, "resource-radar-update-verification");
        worker.start();
    }
}
