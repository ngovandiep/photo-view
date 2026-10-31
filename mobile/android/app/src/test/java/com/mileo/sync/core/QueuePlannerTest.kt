package com.mileo.sync.core

import com.mileo.sync.data.QueueState
import com.mileo.sync.data.QueuedAsset
import com.mileo.sync.data.SkipReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QueuePlannerTest {
    private fun record(id: Int, name: String = "IMG_$id.jpg", size: Long = 100, modified: Long = 1_000, bucket: String = "cam") = MediaRecord(
        mediaKey = "external_primary:$id", uri = "content://media/external_primary/images/media/$id", kind = "image",
        displayName = name, mimeType = "image/jpeg", size = size, dateModified = modified, capturedAt = 5_000,
        folderPath = "DCIM/Camera", bucketId = bucket,
    )

    private fun apply(existing: List<QueuedAsset>, scanned: List<MediaRecord>): Map<String, QueuedAsset> {
        val rows = existing.associateBy { it.mediaKey }.toMutableMap()
        QueuePlanner.reconcile(existing, scanned, 42).forEach { rows[it.mediaKey] = it }
        return rows
    }

    @Test fun newSupportedItemsArePendingAndUnsupportedAreSkipped() {
        val rows = apply(emptyList(), listOf(record(1), record(2, name = "doc.pdf")))
        assertEquals(QueueState.PENDING, rows["external_primary:1"]!!.state)
        assertEquals(QueueState.SKIPPED, rows["external_primary:2"]!!.state)
        assertEquals(SkipReason.UNSUPPORTED, rows["external_primary:2"]!!.skipReason)
    }

    @Test fun completedItemsAreNotRequeuedOnRescan() {
        val first = apply(emptyList(), listOf(record(1)))
        val done = first.values.map { it.copy(state = QueueState.COMPLETED, sha256 = "a".repeat(64), serverAssetId = "s1") }
        assertTrue(QueuePlanner.reconcile(done, listOf(record(1)), 99).isEmpty())
    }

    @Test fun editedFileBecomesANewVersion() {
        val done = apply(emptyList(), listOf(record(1))).values.map { it.copy(state = QueueState.COMPLETED, sha256 = "a".repeat(64), serverAssetId = "s1") }
        val rows = apply(done, listOf(record(1, size = 150, modified = 2_000)))
        val item = rows["external_primary:1"]!!
        assertEquals(QueueState.PENDING, item.state)
        assertNull(item.sha256)
        assertNull(item.serverAssetId)
        assertNotEquals(done.first().sourceAssetId, item.sourceAssetId)
    }

    @Test fun deselectedPendingItemsAreExcludedAndComeBackWhenReselected() {
        val pending = apply(emptyList(), listOf(record(1), record(2))).values.toList()
        val completed = pending.map { if (it.mediaKey.endsWith(":2")) it.copy(state = QueueState.COMPLETED) else it }
        val afterDeselect = apply(completed, emptyList())
        assertEquals(SkipReason.EXCLUDED, afterDeselect["external_primary:1"]!!.skipReason)
        assertEquals(QueueState.COMPLETED, afterDeselect["external_primary:2"]!!.state)
        val afterReselect = apply(afterDeselect.values.toList(), listOf(record(1), record(2)))
        assertEquals(QueueState.PENDING, afterReselect["external_primary:1"]!!.state)
        assertEquals(QueueState.COMPLETED, afterReselect["external_primary:2"]!!.state)
    }

    @Test fun sourceAssetIdIsStableAndVersioned() {
        val item = apply(emptyList(), listOf(record(7))).values.single()
        assertEquals("android:external_primary:7:100:1000", item.sourceAssetId)
        assertEquals("android:external_primary:7:100:1000:g2", item.copy(generation = 2).sourceAssetId)
    }
}
