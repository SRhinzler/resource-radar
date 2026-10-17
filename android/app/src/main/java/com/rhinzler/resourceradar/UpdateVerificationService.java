package com.rhinzler.resourceradar;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Android owns verification lifetime after the download-completion receiver returns. */
public final class UpdateVerificationService extends JobService {
    private static final int JOB_ID = 0x5256;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Future<?> work;
    private volatile JobParameters running;

    static boolean schedule(Context context) {
        try {
            JobScheduler scheduler = context.getSystemService(JobScheduler.class);
            if (scheduler == null) return false;
            if (scheduler.getPendingJob(JOB_ID) != null) return true;
            return scheduler.schedule(new JobInfo.Builder(JOB_ID,
                    new ComponentName(context, UpdateVerificationService.class))
                    .setOverrideDeadline(0).setPersisted(true).build()) == JobScheduler.RESULT_SUCCESS;
        } catch (RuntimeException exception) { return false; }
    }

    @Override
    public boolean onStartJob(JobParameters parameters) {
        running = parameters;
        work = worker.submit(() -> {
            UpdateManager updater = UpdateManager.get(this);
            try {
                updater.getStatus(); // Recover a missed completion or an old-policy verification receipt.
                updater.verifyCompletedDownload();
            }
            finally {
                if (running == parameters) jobFinished(parameters, updater.needsVerification());
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters parameters) {
        running = null;
        if (work != null) work.cancel(true);
        return true;
    }

    @Override
    public void onDestroy() {
        running = null;
        worker.shutdownNow();
        super.onDestroy();
    }
}
