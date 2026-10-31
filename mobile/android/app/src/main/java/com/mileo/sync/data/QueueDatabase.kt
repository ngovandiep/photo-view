package com.mileo.sync.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface QueueDao {
    @Query("SELECT * FROM queue")
    suspend fun all(): List<QueuedAsset>

    @Query("SELECT * FROM queue WHERE state = 'pending' AND nextAttemptAt <= :now ORDER BY COALESCE(capturedAt, dateModified * 1000) DESC LIMIT :limit")
    suspend fun due(now: Long, limit: Int): List<QueuedAsset>

    @Query("SELECT MIN(nextAttemptAt) FROM queue WHERE state = 'pending'")
    suspend fun nextPendingAt(): Long?

    @Query("UPDATE queue SET state = 'pending', updatedAt = :now WHERE state = 'uploading'")
    suspend fun resetInterrupted(now: Long)

    @Query("UPDATE queue SET serverAssetId = NULL, serverStatus = NULL, bytesUploaded = 0, updatedAt = :now WHERE state != 'completed'")
    suspend fun forgetServerRecords(now: Long)

    @Query("UPDATE queue SET state = 'pending', skipReason = NULL, serverAssetId = NULL, serverStatus = NULL, bytesUploaded = 0, attempts = 0, nextAttemptAt = 0, lastError = NULL, completedAt = NULL, updatedAt = :now WHERE NOT (state = 'skipped' AND skipReason = 'excluded')")
    suspend fun resetAllForNewDesktop(now: Long)

    @Query("UPDATE queue SET state = 'pending', generation = generation + 1, sha256 = NULL, hashedSize = NULL, serverAssetId = NULL, serverStatus = NULL, bytesUploaded = 0, attempts = 0, nextAttemptAt = 0, lastError = NULL, updatedAt = :now WHERE state = 'failed'")
    suspend fun retryFailed(now: Long): Int

    @Upsert
    suspend fun upsert(item: QueuedAsset)

    @Upsert
    suspend fun upsertAll(items: List<QueuedAsset>)

    @Query("SELECT state, COUNT(*) AS count FROM queue GROUP BY state")
    fun stateCounts(): Flow<List<StateCount>>

    @Query("SELECT kind, COUNT(*) AS count FROM queue WHERE NOT (state = 'skipped' AND skipReason = 'excluded') GROUP BY kind")
    fun selectedKindCounts(): Flow<List<KindCount>>

    @Query("SELECT * FROM queue WHERE state = 'failed' ORDER BY updatedAt DESC LIMIT 50")
    fun failed(): Flow<List<QueuedAsset>>
}

@Database(entities = [QueuedAsset::class], version = 1, exportSchema = true)
abstract class QueueDatabase : RoomDatabase() {
    abstract fun queue(): QueueDao

    companion object {
        @Volatile private var instance: QueueDatabase? = null

        fun get(context: Context): QueueDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, QueueDatabase::class.java, "mileo-sync-queue.db")
                .build().also { instance = it }
        }
    }
}
