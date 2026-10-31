package com.mileo.sync.core

import com.mileo.sync.data.QueueDao
import com.mileo.sync.data.QueueState
import com.mileo.sync.data.QueuedAsset
import com.mileo.sync.data.SkipReason
import java.io.InputStream

/** Persistent queue operations the upload engine needs (Room in the app, in-memory in tests). */
interface UploadQueue {
    suspend fun resetInterrupted(now: Long)
    suspend fun due(now: Long, limit: Int): List<QueuedAsset>
    suspend fun save(item: QueuedAsset)
}

class RoomUploadQueue(private val dao: QueueDao) : UploadQueue {
    override suspend fun resetInterrupted(now: Long) = dao.resetInterrupted(now)
    override suspend fun due(now: Long, limit: Int) = dao.due(now, limit)
    override suspend fun save(item: QueuedAsset) = dao.upsert(item)
}

/** Opens the original bytes of a queued phone media item. Must never modify or delete it. */
fun interface MediaReader {
    fun open(item: QueuedAsset): InputStream
}

/** A media item found on the phone by the scanner. */
data class MediaRecord(
    val mediaKey: String,
    val uri: String,
    val kind: String,
    val displayName: String,
    val mimeType: String,
    val size: Long,
    val dateModified: Long,
    val capturedAt: Long?,
    val folderPath: String?,
    val bucketId: String?,
)

object SupportedMedia {
    // Mirrors the desktop importer's accepted extensions (electron/wifi-sync/importer.cjs).
    val IMAGE = setOf("jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "heif", "tif", "tiff", "dng")
    val VIDEO = setOf("mp4", "m4v", "mov", "webm", "mkv", "ogv", "avi", "3gp")

    fun extension(name: String) = name.substringAfterLast('.', "").lowercase()
    fun isSupported(name: String) = extension(name).let { it in IMAGE || it in VIDEO }
}

object Backoff {
    const val BASE_MS = 30_000L
    const val MAX_MS = 60 * 60_000L

    /** 30 s, 60 s, 2 min ... capped at 1 hour (same schedule as the desktop's retry policy). */
    fun delayMs(attempts: Int): Long {
        if (attempts <= 0) return 0
        val shift = (attempts - 1).coerceAtMost(20)
        return (BASE_MS shl shift).coerceAtMost(MAX_MS)
    }
}

/**
 * Merges a MediaStore scan into the persistent queue. Pure function: returns rows to upsert.
 * Completed items are never re-queued unless the phone file itself changed (new version).
 */
object QueuePlanner {
    fun reconcile(existing: Collection<QueuedAsset>, scanned: List<MediaRecord>, now: Long): List<QueuedAsset> {
        val byKey = existing.associateBy { it.mediaKey }
        val seen = HashSet<String>()
        val changes = ArrayList<QueuedAsset>()
        for (record in scanned) {
            seen += record.mediaKey
            val current = byKey[record.mediaKey]
            val supported = SupportedMedia.isSupported(record.displayName)
            if (current == null) {
                val fresh = QueuedAsset(
                    mediaKey = record.mediaKey, uri = record.uri, kind = record.kind, displayName = record.displayName,
                    mimeType = record.mimeType, size = record.size, dateModified = record.dateModified,
                    capturedAt = record.capturedAt, folderPath = record.folderPath, bucketId = record.bucketId,
                    discoveredAt = now, updatedAt = now,
                )
                changes += if (supported) fresh else fresh.copy(state = QueueState.SKIPPED, skipReason = SkipReason.UNSUPPORTED)
                continue
            }
            val changed = current.size != record.size || current.dateModified != record.dateModified
            val withMeta = current.copy(
                uri = record.uri, kind = record.kind, displayName = record.displayName, mimeType = record.mimeType,
                size = record.size, dateModified = record.dateModified, capturedAt = record.capturedAt,
                folderPath = record.folderPath, bucketId = record.bucketId,
            )
            when {
                changed && supported -> changes += withMeta.resetForUpload(now)
                current.state == QueueState.SKIPPED && current.skipReason in REACTIVATE && supported ->
                    changes += withMeta.copy(state = QueueState.PENDING, skipReason = null, lastError = null, updatedAt = now)
                withMeta != current -> changes += withMeta.copy(updatedAt = now)
            }
        }
        for (item in existing) {
            if (item.mediaKey in seen) continue
            if (item.state == QueueState.PENDING || item.state == QueueState.FAILED || item.state == QueueState.UPLOADING) {
                changes += item.copy(state = QueueState.SKIPPED, skipReason = SkipReason.EXCLUDED, updatedAt = now)
            }
        }
        return changes
    }

    private val REACTIVATE = setOf(SkipReason.EXCLUDED, SkipReason.MISSING)
}
