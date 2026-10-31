package com.mileo.sync.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.room.withTransaction
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.mileo.sync.R
import com.mileo.sync.core.PinnedHttp
import com.mileo.sync.core.QueuePlanner
import com.mileo.sync.core.RoomUploadQueue
import com.mileo.sync.core.RunResult
import com.mileo.sync.core.SyncApi
import com.mileo.sync.core.UploadEngine
import com.mileo.sync.data.QueueDatabase
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object SyncScheduler {
    const val WORK_NOW = "mileo-sync-now"
    const val WORK_RETRY = "mileo-sync-retry"
    const val WORK_PERIODIC = "mileo-sync-periodic"
    const val WORK_MEDIA_TRIGGER = "mileo-sync-new-media"
    const val TAG = "mileo-sync"

    fun constraints(settings: SyncSettings): Constraints = Constraints.Builder()
        .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(settings.chargingOnly)
        .build()

    fun syncNow(context: Context) {
        val settings = SyncPrefs.get(context).settings.value
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints(settings))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NOW, ExistingWorkPolicy.KEEP, request)
    }

    /** Wakes the queue again when the earliest backed-off item becomes due (works in manual mode too). */
    fun retryAt(context: Context, delayMs: Long) {
        val settings = SyncPrefs.get(context).settings.value
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInitialDelay(delayMs.coerceAtLeast(15_000), TimeUnit.MILLISECONDS)
            .setConstraints(constraints(settings))
            .addTag(TAG)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_RETRY, ExistingWorkPolicy.REPLACE, request)
    }

    /** Applies automatic-backup and network/charging rules. Call after any settings change. */
    fun apply(context: Context) {
        val prefs = SyncPrefs.get(context)
        val settings = prefs.settings.value
        val manager = WorkManager.getInstance(context)
        val paired = prefs.pairing.value?.revoked == false
        if (!paired || !settings.autoBackup) {
            manager.cancelUniqueWork(WORK_PERIODIC)
            manager.cancelUniqueWork(WORK_MEDIA_TRIGGER)
            return
        }
        // Android runs periodic work at most every 15 minutes, and later under Doze or battery saver.
        val periodic = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints(settings))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(TAG)
            .build()
        manager.enqueueUniquePeriodicWork(WORK_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, periodic)
        enqueueMediaTrigger(context, settings)
    }

    /** Runs a sync shortly after new photos/videos appear in MediaStore (while the app process may be stopped). */
    fun enqueueMediaTrigger(context: Context, settings: SyncSettings) {
        val trigger = Constraints.Builder()
            .setRequiredNetworkType(if (settings.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(settings.chargingOnly)
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(30, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(5, TimeUnit.MINUTES)
            .build()
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(trigger)
            .setInputData(workDataOf(SyncWorker.KEY_MEDIA_TRIGGER to true))
            .addTag(TAG)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_MEDIA_TRIGGER, ExistingWorkPolicy.REPLACE, request)
    }

    fun cancelAll(context: Context) {
        val manager = WorkManager.getInstance(context)
        listOf(WORK_NOW, WORK_RETRY, WORK_PERIODIC, WORK_MEDIA_TRIGGER).forEach(manager::cancelUniqueWork)
    }
}

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val prefs = SyncPrefs.get(context)
    private val db = QueueDatabase.get(context)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val fromTrigger = inputData.getBoolean(KEY_MEDIA_TRIGGER, false)
        try {
            runSync()
        } finally {
            // A content-URI trigger fires once; re-arm it while automatic backup is on.
            if (fromTrigger && prefs.settings.value.autoBackup) SyncScheduler.enqueueMediaTrigger(applicationContext, prefs.settings.value)
        }
    }

    private suspend fun runSync(): Result {
        val pairing = prefs.pairing.value ?: return Result.success()
        if (pairing.revoked || prefs.settings.value.paused) return Result.success()
        val token = prefs.token() ?: return Result.success()
        val settings = prefs.settings.value

        val scanner = MediaScanner(applicationContext)
        if (!MediaAccess.canRead(applicationContext, "image") && !MediaAccess.canRead(applicationContext, "video")) {
            prefs.recordOutcome(SyncOutcome(System.currentTimeMillis(), "Photo access is off. Open MiLeo Sync to allow it.", false))
            return Result.success()
        }
        reconcile(applicationContext, scanner, settings)

        runCatching { setForeground(foregroundInfo("Preparing backup…", 0, 0)) }
        val dao = db.queue()
        val engine = UploadEngine(
            api = SyncApi(pairing.baseUrl, PinnedHttp.client(pairing.fingerprint), token),
            queue = RoomUploadQueue(dao),
            media = ContentMediaReader(applicationContext) { prefs.settings.value.keepLocation },
            shouldContinue = { !isStopped && !prefs.settings.value.paused },
            onProgress = { progress ->
                setProgressAsync(workDataOf(
                    "file" to progress.fileName, "done" to progress.fileBytesDone, "total" to progress.fileBytesTotal,
                    "files" to progress.filesDone, "phase" to progress.phase,
                ))
                val percent = if (progress.fileBytesTotal > 0) (progress.fileBytesDone * 100 / progress.fileBytesTotal).toInt() else 0
                runCatching {
                    applicationContext.getSystemService(NotificationManager::class.java)
                        .notify(NOTIFICATION_ID, foregroundInfo(progress.fileName, percent, 100).notification)
                }
            },
        )
        val now = System.currentTimeMillis()
        val result = when (val outcome = engine.run()) {
            is RunResult.NothingToDo -> {
                if (dao.nextPendingAt() != null) prefs.recordOutcome(SyncOutcome(now, "Some files are waiting to be retried.", false))
                else prefs.recordOutcome(SyncOutcome(now, "Everything selected is backed up.", true))
                Result.success()
            }
            is RunResult.Finished -> {
                val ok = outcome.failed == 0
                val message = buildString {
                    append("Backed up ${outcome.uploaded}")
                    if (outcome.duplicates > 0) append(", ${outcome.duplicates} already on desktop")
                    if (outcome.failed > 0) append(", ${outcome.failed} failed")
                    if (outcome.skipped > 0) append(", ${outcome.skipped} skipped")
                    append('.')
                }
                prefs.recordOutcome(SyncOutcome(System.currentTimeMillis(), message, ok))
                // More than one batch may be waiting.
                if (dao.due(System.currentTimeMillis(), 1).isNotEmpty()) SyncScheduler.retryAt(applicationContext, 0)
                Result.success()
            }
            is RunResult.Stopped -> {
                val message = if (prefs.settings.value.paused) "Paused." else "Stopped by Android (network or charging rule). Will resume."
                prefs.recordOutcome(SyncOutcome(System.currentTimeMillis(), message, false))
                if (prefs.settings.value.paused) Result.success() else Result.retry()
            }
            is RunResult.DesktopUnreachable -> {
                prefs.recordOutcome(SyncOutcome(now, "Desktop not reachable. Check that the PC is on, Wi-Fi Sync is enabled and you are on the same network.", false))
                Result.retry()
            }
            is RunResult.Unauthorized -> {
                prefs.markRevoked()
                SyncScheduler.cancelAll(applicationContext)
                prefs.recordOutcome(SyncOutcome(now, "This phone was removed on the desktop. Pair again to continue.", false))
                Result.failure()
            }
        }
        dao.nextPendingAt()?.let { next -> if (next > System.currentTimeMillis()) SyncScheduler.retryAt(applicationContext, next - System.currentTimeMillis()) }
        return result
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo("Backing up…", 0, 0)

    private fun foregroundInfo(text: String, progress: Int, max: Int): ForegroundInfo {
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Backup progress", NotificationManager.IMPORTANCE_LOW))
        }
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(R.drawable.ic_sync)
            .setContentTitle("MiLeo Sync")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(max, progress, max == 0)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(NOTIFICATION_ID, notification)
    }

    companion object {
        const val KEY_MEDIA_TRIGGER = "media_trigger"
        private const val CHANNEL = "backup"
        private const val NOTIFICATION_ID = 41

        /** Merges the current MediaStore contents into the queue in one transaction. */
        suspend fun reconcile(context: Context, scanner: MediaScanner, settings: SyncSettings) {
            val db = QueueDatabase.get(context)
            val records = scanner.scan(settings.mediaSelection, settings.buckets)
            db.withTransaction {
                val changes = QueuePlanner.reconcile(db.queue().all(), records, System.currentTimeMillis())
                if (changes.isNotEmpty()) db.queue().upsertAll(changes)
            }
        }
    }
}
