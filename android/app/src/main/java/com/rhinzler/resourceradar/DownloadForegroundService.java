package com.rhinzler.resourceradar;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Minimal process-visibility service for active downloads.
 *
 * <p>The native downloader owns the actual queue.  This service only keeps a visible
 * foreground notification while that queue is active, and deliberately has no UI or
 * binder surface.  The application manifest may register it with the dataSync
 * foreground-service type when the host wires the backend into its activity.</p>
 */
public final class DownloadForegroundService extends Service {
    public static final String CHANNEL_ID = "resource_radar_downloads";
    public static final int NOTIFICATION_ID = 0x5252;
    private static final String ACTION_START = "com.rhinzler.resourceradar.action.START_DOWNLOADS";

    public static void start(Context context) {
        if (context == null) {
            return;
        }
        Context app = context.getApplicationContext();
        Intent intent = new Intent(app, DownloadForegroundService.class);
        intent.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            app.startForegroundService(intent);
        } else {
            app.startService(intent);
        }
    }

    public static void stop(Context context) {
        if (context == null) {
            return;
        }
        Context app = context.getApplicationContext();
        app.stopService(new Intent(app, DownloadForegroundService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // The owning NativeResourceService stops this service after its one queue
        // reaches a terminal state.  Do not resurrect an abandoned queue.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Resource Radar downloads",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Active Resource Radar downloads");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("Downloads running")
                .setContentText("Resource Radar is saving public resources")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setVisibility(Notification.VISIBILITY_PRIVATE);
        return builder.build();
    }
}
