package com.mileo.sync.android

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import com.mileo.sync.core.MediaReader
import com.mileo.sync.core.MediaRecord
import com.mileo.sync.data.QueuedAsset
import java.io.FileNotFoundException
import java.io.InputStream

data class Album(val bucketId: String, val name: String, val photos: Int, val videos: Int)

/** Read-only access to the phone's photos and videos through MediaStore. Never writes or deletes media. */
class MediaScanner(private val context: Context) {
    private val resolver: ContentResolver get() = context.contentResolver

    fun scan(selection: MediaSelection, buckets: Set<String>): List<MediaRecord> {
        val result = ArrayList<MediaRecord>()
        if (selection != MediaSelection.VIDEOS && MediaAccess.canRead(context, "image")) result += query("image", buckets)
        if (selection != MediaSelection.PHOTOS && MediaAccess.canRead(context, "video")) result += query("video", buckets)
        return result
    }

    fun albums(): List<Album> {
        val counts = LinkedHashMap<String, Triple<String, Int, Int>>()
        for (kind in listOf("image", "video")) {
            if (!MediaAccess.canRead(context, kind)) continue
            val projection = arrayOf(MediaStore.MediaColumns.BUCKET_ID, MediaStore.MediaColumns.BUCKET_DISPLAY_NAME)
            resolver.query(collection(kind), projection, visibleOnly(), null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: "Unnamed"
                    val (n, photos, videos) = counts[id] ?: Triple(name, 0, 0)
                    counts[id] = if (kind == "image") Triple(n, photos + 1, videos) else Triple(n, photos, videos + 1)
                }
            }
        }
        return counts.map { (id, value) -> Album(id, value.first, value.second, value.third) }.sortedBy { it.name.lowercase() }
    }

    private fun collection(kind: String): Uri = when {
        Build.VERSION.SDK_INT >= 29 && kind == "image" -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        Build.VERSION.SDK_INT >= 29 -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        kind == "image" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        else -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    }

    private fun visibleOnly(): String? = if (Build.VERSION.SDK_INT >= 29) "${MediaStore.MediaColumns.IS_PENDING} = 0" else null

    private fun query(kind: String, buckets: Set<String>): List<MediaRecord> {
        val columns = mutableListOf(
            MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.BUCKET_ID,
            MediaStore.MediaColumns.BUCKET_DISPLAY_NAME, "datetaken",
        )
        if (Build.VERSION.SDK_INT >= 29) columns += listOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.VOLUME_NAME)
        val clauses = listOfNotNull(visibleOnly(), buckets.takeIf { it.isNotEmpty() }?.let { set ->
            "${MediaStore.MediaColumns.BUCKET_ID} IN (${set.joinToString(",") { "?" }})"
        })
        val args = buckets.takeIf { it.isNotEmpty() }?.toTypedArray()
        val records = ArrayList<MediaRecord>()
        resolver.query(collection(kind), columns.toTypedArray(), clauses.joinToString(" AND ").ifEmpty { null }, args, null)?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val mimeCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
            val sizeCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val modCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
            val bucketCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.BUCKET_ID)
            val bucketNameCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME)
            val takenCol = c.getColumnIndex("datetaken")
            val pathCol = c.getColumnIndex("relative_path")
            val volumeCol = c.getColumnIndex("volume_name")
            while (c.moveToNext()) {
                val id = c.getLong(idCol)
                val volume = if (volumeCol >= 0) c.getString(volumeCol) ?: "external" else "external"
                val name = c.getString(nameCol) ?: continue
                val size = c.getLong(sizeCol)
                if (size <= 0) continue
                val base = if (Build.VERSION.SDK_INT >= 29) {
                    if (kind == "image") MediaStore.Images.Media.getContentUri(volume) else MediaStore.Video.Media.getContentUri(volume)
                } else collection(kind)
                val folder = (if (pathCol >= 0) c.getString(pathCol) else null)?.trim('/')?.ifBlank { null }
                    ?: c.getString(bucketNameCol)
                records += MediaRecord(
                    mediaKey = "$volume:$id",
                    uri = ContentUris.withAppendedId(base, id).toString(),
                    kind = kind,
                    displayName = name,
                    mimeType = c.getString(mimeCol) ?: "",
                    size = size,
                    dateModified = c.getLong(modCol),
                    capturedAt = if (takenCol >= 0 && !c.isNull(takenCol)) c.getLong(takenCol).takeIf { it > 0 } else null,
                    folderPath = folder,
                    bucketId = c.getString(bucketCol),
                )
            }
        }
        return records
    }
}

class ContentMediaReader(private val context: Context, private val keepLocation: () -> Boolean) : MediaReader {
    override fun open(item: QueuedAsset): InputStream {
        var uri = Uri.parse(item.uri)
        // Without this, Android strips GPS data from photos read by apps that lack ACCESS_MEDIA_LOCATION.
        if (Build.VERSION.SDK_INT >= 29 && item.kind == "image" && keepLocation() && MediaAccess.hasLocation(context)) {
            uri = MediaStore.setRequireOriginal(uri)
        }
        return context.contentResolver.openInputStream(uri) ?: throw FileNotFoundException(item.displayName)
    }
}

enum class AccessLevel { NONE, PARTIAL, FULL }

object MediaAccess {
    /** Minimum permissions for the chosen media types. */
    fun permissionsFor(selection: MediaSelection): Array<String> = when {
        Build.VERSION.SDK_INT >= 33 -> buildList {
            if (selection != MediaSelection.VIDEOS) add(Manifest.permission.READ_MEDIA_IMAGES)
            if (selection != MediaSelection.PHOTOS) add(Manifest.permission.READ_MEDIA_VIDEO)
            if (Build.VERSION.SDK_INT >= 34) add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        }.toTypedArray()
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    fun level(context: Context, kind: String): AccessLevel {
        fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        return when {
            Build.VERSION.SDK_INT >= 33 -> {
                val full = granted(if (kind == "image") Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_MEDIA_VIDEO)
                when {
                    full -> AccessLevel.FULL
                    Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> AccessLevel.PARTIAL
                    else -> AccessLevel.NONE
                }
            }
            granted(Manifest.permission.READ_EXTERNAL_STORAGE) -> AccessLevel.FULL
            else -> AccessLevel.NONE
        }
    }

    fun canRead(context: Context, kind: String) = level(context, kind) != AccessLevel.NONE

    fun hasLocation(context: Context) = Build.VERSION.SDK_INT < 29 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED
}
