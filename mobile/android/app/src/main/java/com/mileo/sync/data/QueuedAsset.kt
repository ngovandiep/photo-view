package com.mileo.sync.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

object QueueState {
    const val PENDING = "pending"
    const val UPLOADING = "uploading"
    const val COMPLETED = "completed"
    const val SKIPPED = "skipped"
    const val FAILED = "failed"
}

object SkipReason {
    /** Not in the selected albums / media types any more. Re-activated when selected again. */
    const val EXCLUDED = "excluded"
    /** The file disappeared from the phone. Re-activated if it reappears. */
    const val MISSING = "missing"
    const val UNSUPPORTED = "unsupported"
    const val TOO_LARGE = "too_large"
}

/**
 * One phone media item in the persistent upload queue. [mediaKey] is the stable MediaStore identity
 * (`<volume>:<_ID>`); the version (`size` + `dateModified`) and [generation] make up the server-side
 * `sourceAssetId`, so an edited file is backed up as a new version and a user retry after a permanent
 * failure gets a fresh server record.
 */
@Entity(tableName = "queue", indices = [Index("state"), Index("nextAttemptAt")])
data class QueuedAsset(
    @PrimaryKey val mediaKey: String,
    val uri: String,
    val kind: String,
    val displayName: String,
    val mimeType: String,
    val size: Long,
    val dateModified: Long,
    val capturedAt: Long?,
    val folderPath: String?,
    val bucketId: String?,
    val state: String = QueueState.PENDING,
    val skipReason: String? = null,
    val generation: Int = 0,
    val sha256: String? = null,
    val hashedSize: Long? = null,
    val serverAssetId: String? = null,
    val serverStatus: String? = null,
    val bytesUploaded: Long = 0,
    val attempts: Int = 0,
    val nextAttemptAt: Long = 0,
    val lastError: String? = null,
    val discoveredAt: Long = 0,
    val updatedAt: Long = 0,
    val completedAt: Long? = null,
) {
    val sourceAssetId: String
        get() = "android:$mediaKey:$size:$dateModified" + if (generation > 0) ":g$generation" else ""

    /** Clears everything derived from the file content or the server record. */
    fun resetForUpload(now: Long) = copy(
        state = QueueState.PENDING, skipReason = null, sha256 = null, hashedSize = null, serverAssetId = null,
        serverStatus = null, bytesUploaded = 0, attempts = 0, nextAttemptAt = 0, lastError = null, updatedAt = now,
        completedAt = null,
    )
}

data class StateCount(val state: String, val count: Int)
data class KindCount(val kind: String, val count: Int)
