package com.mileo.sync.core

import com.mileo.sync.data.QueueState
import com.mileo.sync.data.QueuedAsset
import com.mileo.sync.data.SkipReason
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

data class SyncProgress(
    val fileName: String,
    val fileBytesDone: Long,
    val fileBytesTotal: Long,
    val filesDone: Int,
    val phase: String,
)

sealed interface RunResult {
    data class Finished(val uploaded: Int, val duplicates: Int, val failed: Int, val skipped: Int) : RunResult
    data object NothingToDo : RunResult
    /** Paused by the user or the OS stopped the work (constraints lost). Remaining items stay pending. */
    data object Stopped : RunResult
    data class DesktopUnreachable(val message: String) : RunResult
    /** The desktop no longer accepts this phone's credential (revoked). */
    data object Unauthorized : RunResult
}

/**
 * Uploads due queue items to the desktop. Every state change is persisted before and after network
 * operations, so killing the app at any point leaves the queue resumable. Phone files are only read.
 */
class UploadEngine(
    private val api: SyncApi,
    private val queue: UploadQueue,
    private val media: MediaReader,
    private val clock: () -> Long = System::currentTimeMillis,
    private val chunkSize: Int = 8 * 1024 * 1024,
    private val maxAttempts: Int = 8,
    private val shouldContinue: () -> Boolean = { true },
    private val onProgress: (SyncProgress) -> Unit = {},
) {
    private class StopRequested : Exception()
    private class FileChanged : Exception()

    private var filesDone = 0

    suspend fun run(batchLimit: Int = 500): RunResult {
        queue.resetInterrupted(clock())
        val due = queue.due(clock(), batchLimit)
        if (due.isEmpty()) return RunResult.NothingToDo
        try {
            api.ping()
        } catch (error: IOException) {
            return RunResult.DesktopUnreachable(error.message ?: "Desktop is not reachable.")
        }
        val session = try {
            api.createSession(UUID.randomUUID().toString())
        } catch (error: IOException) {
            return RunResult.DesktopUnreachable(error.message ?: "Desktop is not reachable.")
        } catch (error: ApiException) {
            return if (error.isUnauthorized) RunResult.Unauthorized else RunResult.DesktopUnreachable(error.message ?: "")
        }
        var uploaded = 0
        var duplicates = 0
        var failed = 0
        var skipped = 0
        for (original in due) {
            if (!shouldContinue()) return RunResult.Stopped
            val outcome = try {
                process(original, session.id)
            } catch (_: StopRequested) {
                return RunResult.Stopped
            } catch (error: IOException) {
                // Connection dropped: keep the item (and its server-side offset) and end this run.
                return RunResult.DesktopUnreachable(error.message ?: "Connection to the desktop was lost.")
            } catch (error: ApiException) {
                if (error.isUnauthorized) return RunResult.Unauthorized
                throw error
            }
            when (outcome.state) {
                QueueState.COMPLETED -> if (outcome.serverStatus == "duplicate") duplicates++ else uploaded++
                QueueState.FAILED -> failed++
                QueueState.SKIPPED -> skipped++
            }
            filesDone++
        }
        runCatching { api.completeSession(session.id) }
        return RunResult.Finished(uploaded, duplicates, failed, skipped)
    }

    private suspend fun process(original: QueuedAsset, sessionId: String): QueuedAsset {
        var item = original
        try {
            if (item.sha256 == null) item = hash(item)
            if (item.serverAssetId == null) {
                item = register(item, sessionId)
                if (item.state != QueueState.PENDING) return item
            }
            return upload(item)
        } catch (_: FileNotFoundException) {
            return save(item.copy(state = QueueState.SKIPPED, skipReason = SkipReason.MISSING, lastError = "The file is no longer on this phone."))
        } catch (_: SecurityException) {
            return transient(item, "MiLeo cannot read this file. Check photo access permission.")
        } catch (_: FileChanged) {
            // The phone file changed while uploading: hash and upload it again as a new record.
            return save(item.resetForUpload(clock()).copy(generation = item.generation + 1))
        } catch (error: ApiException) {
            if (error.isUnauthorized) {
                save(item.copy(state = QueueState.PENDING))
                throw error
            }
            return handleApiError(item, error)
        } catch (error: IOException) {
            save(item.copy(state = QueueState.PENDING, attempts = item.attempts + 1,
                nextAttemptAt = clock() + Backoff.delayMs(item.attempts + 1), lastError = "Connection lost. Will retry."))
            throw error
        }
    }

    private fun hash(item: QueuedAsset): QueuedAsset {
        onProgress(SyncProgress(item.displayName, 0, item.size, filesDone, "checking"))
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        media.open(item).use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
                if (!shouldContinue()) throw StopRequested()
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
                total += read
            }
        }
        if (total == 0L) throw FileNotFoundException("empty")
        return item.copy(sha256 = digest.digest().joinToString("") { "%02x".format(it) }, hashedSize = total)
    }

    private suspend fun register(item: QueuedAsset, sessionId: String): QueuedAsset {
        val size = item.hashedSize ?: item.size
        val registration = AssetRegistration(
            sourceAssetId = item.sourceAssetId,
            filename = item.displayName,
            mediaType = item.mimeType.ifBlank { "application/octet-stream" },
            size = size,
            capturedAt = item.capturedAt,
            folderPath = item.folderPath,
            sha256 = item.sha256,
        )
        val result = api.registerAssets(sessionId, listOf(registration)).first()
        result.error?.let { error ->
            return when (error.code) {
                "unsupported_type" -> save(item.copy(state = QueueState.SKIPPED, skipReason = SkipReason.UNSUPPORTED, lastError = error.message))
                "too_large" -> save(item.copy(state = QueueState.SKIPPED, skipReason = SkipReason.TOO_LARGE, lastError = error.message))
                else -> save(item.copy(state = QueueState.FAILED, lastError = error.message))
            }
        }
        val asset = result.asset ?: return save(item.copy(state = QueueState.FAILED, lastError = "Desktop gave no answer for this file."))
        return applyServerState(save(item.copy(serverAssetId = asset.id, serverStatus = asset.status)), asset)
    }

    private suspend fun upload(start: QueuedAsset): QueuedAsset {
        var item = save(start.copy(state = QueueState.UPLOADING, lastError = null))
        val assetId = item.serverAssetId!!
        val total = item.hashedSize ?: item.size
        val head = api.uploadState(assetId)
        if (head.state == "stored" || head.state == "indexed") return applyServerState(item, api.asset(assetId))
        var offset = head.offset
        val buffer = ByteArray(chunkSize)
        while (true) {
            var reopen = false
            media.open(item).use { input ->
                skipFully(input, offset)
                while (offset < total && !reopen) {
                    if (!shouldContinue()) {
                        save(item.copy(state = QueueState.PENDING, bytesUploaded = offset))
                        throw StopRequested()
                    }
                    val wanted = minOf(chunkSize.toLong(), total - offset).toInt()
                    val count = readFully(input, buffer, wanted)
                    if (count < wanted) throw FileChanged()
                    onProgress(SyncProgress(item.displayName, offset, total, filesDone, "uploading"))
                    when (val result = api.putChunk(assetId, offset, api.octetBody(buffer, 0, count))) {
                        is ChunkResult.OffsetMismatch -> { offset = result.expectedOffset; reopen = true }
                        is ChunkResult.Accepted -> {
                            offset = result.offset
                            item = save(item.copy(bytesUploaded = offset, serverStatus = result.asset.status))
                            if (result.asset.isSafelyStored || result.asset.isClosed) return applyServerState(item, result.asset)
                        }
                    }
                }
            }
            if (!reopen) break
        }
        // Every byte was sent but the desktop has not committed the file yet (for example, disk was full).
        val asset = api.asset(assetId)
        return applyServerState(item, asset)
    }

    private suspend fun applyServerState(item: QueuedAsset, asset: AssetDto): QueuedAsset = when {
        asset.isSafelyStored -> save(item.copy(
            state = QueueState.COMPLETED, serverStatus = if (asset.duplicateOf != null) "duplicate" else asset.status,
            bytesUploaded = asset.size, lastError = null, completedAt = clock(),
        ))
        asset.state == "failed_permanent" -> save(item.copy(
            state = QueueState.FAILED, serverStatus = asset.status,
            lastError = asset.error?.let { "Desktop rejected the file: $it" } ?: "Desktop rejected the file.",
        ))
        asset.state == "cancelled" -> save(item.copy(state = QueueState.FAILED, lastError = "Upload was cancelled on the desktop."))
        item.state == QueueState.UPLOADING -> transient(item, asset.error ?: "Desktop has not confirmed the file yet.")
        else -> item
    }

    private suspend fun handleApiError(item: QueuedAsset, error: ApiException): QueuedAsset = when {
        error.status == 404 && item.serverAssetId != null ->
            // The desktop no longer knows this upload (for example, after re-pairing): register again.
            save(item.copy(state = QueueState.PENDING, serverAssetId = null, bytesUploaded = 0, lastError = null))
        error.code == "asset_closed" -> save(item.copy(state = QueueState.FAILED, lastError = error.message))
        error.status == 429 || error.status == 409 || error.status >= 500 -> transient(item, error.message ?: "Desktop is busy.")
        else -> save(item.copy(state = QueueState.FAILED, lastError = error.message))
    }

    private suspend fun transient(item: QueuedAsset, message: String): QueuedAsset {
        val attempts = item.attempts + 1
        return if (attempts >= maxAttempts) {
            save(item.copy(state = QueueState.FAILED, attempts = attempts, lastError = message))
        } else {
            save(item.copy(state = QueueState.PENDING, attempts = attempts, nextAttemptAt = clock() + Backoff.delayMs(attempts), lastError = message))
        }
    }

    private suspend fun save(item: QueuedAsset): QueuedAsset {
        val stamped = item.copy(updatedAt = clock())
        queue.save(stamped)
        return stamped
    }

    private fun skipFully(input: InputStream, count: Long) {
        var remaining = count
        val scratch = ByteArray(64 * 1024)
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) { remaining -= skipped; continue }
            val read = input.read(scratch, 0, minOf(scratch.size.toLong(), remaining).toInt())
            if (read < 0) throw FileChanged()
            remaining -= read
        }
    }

    private fun readFully(input: InputStream, buffer: ByteArray, wanted: Int): Int {
        var total = 0
        while (total < wanted) {
            val read = input.read(buffer, total, wanted - total)
            if (read < 0) break
            total += read
        }
        return total
    }
}
