package com.mileo.sync.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.mileo.sync.android.AccessLevel
import com.mileo.sync.android.Album
import com.mileo.sync.android.MediaAccess
import com.mileo.sync.android.MediaScanner
import com.mileo.sync.android.MediaSelection
import com.mileo.sync.android.SyncPrefs
import com.mileo.sync.android.SyncScheduler
import com.mileo.sync.android.SyncSettings
import com.mileo.sync.android.SyncWorker
import com.mileo.sync.core.ApiException
import com.mileo.sync.core.PairingFlow
import com.mileo.sync.core.PairingLinks
import com.mileo.sync.core.PinnedHttp
import com.mileo.sync.core.SyncApi
import com.mileo.sync.data.QueueDatabase
import com.mileo.sync.data.QueueState
import com.mileo.sync.data.QueuedAsset
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface Connection {
    data object Unknown : Connection
    data object Checking : Connection
    data class Online(val appVersion: String?) : Connection
    data class Offline(val message: String) : Connection
    data object Revoked : Connection
}

data class QueueCounts(
    val photos: Int = 0, val videos: Int = 0,
    val pending: Int = 0, val uploading: Int = 0, val completed: Int = 0, val skipped: Int = 0, val failed: Int = 0,
)

data class ActiveWork(val running: Boolean, val enqueued: Boolean, val file: String?, val done: Long, val total: Long, val phase: String?)

data class Access(val photos: AccessLevel, val videos: AccessLevel, val location: Boolean)

class SyncViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = SyncPrefs.get(app)
    private val dao = QueueDatabase.get(app).queue()
    private val scanner = MediaScanner(app)

    val pairing = prefs.pairing
    val settings = prefs.settings
    val lastSuccessfulSync = prefs.lastSuccessfulSync
    val lastOutcome = prefs.lastOutcome

    val counts: StateFlow<QueueCounts> = combine(dao.stateCounts(), dao.selectedKindCounts()) { states, kinds ->
        val byState = states.associate { it.state to it.count }
        val byKind = kinds.associate { it.kind to it.count }
        QueueCounts(
            photos = byKind["image"] ?: 0, videos = byKind["video"] ?: 0,
            pending = byState[QueueState.PENDING] ?: 0, uploading = byState[QueueState.UPLOADING] ?: 0,
            completed = byState[QueueState.COMPLETED] ?: 0, skipped = byState[QueueState.SKIPPED] ?: 0,
            failed = byState[QueueState.FAILED] ?: 0,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), QueueCounts())

    val failedItems: StateFlow<List<QueuedAsset>> = dao.failed().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val work: StateFlow<ActiveWork> = WorkManager.getInstance(app).getWorkInfosByTagFlow(SyncScheduler.TAG).map { infos ->
        val running = infos.firstOrNull { it.state == WorkInfo.State.RUNNING }
        ActiveWork(
            running = running != null,
            enqueued = infos.any { it.state == WorkInfo.State.ENQUEUED },
            file = running?.progress?.getString("file"),
            done = running?.progress?.getLong("done", 0) ?: 0,
            total = running?.progress?.getLong("total", 0) ?: 0,
            phase = running?.progress?.getString("phase"),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ActiveWork(false, false, null, 0, 0, null))

    val connection = MutableStateFlow<Connection>(Connection.Unknown)
    val albums = MutableStateFlow<List<Album>>(emptyList())
    val access = MutableStateFlow(readAccess())
    val busy = MutableStateFlow(false)
    val message = MutableStateFlow<String?>(null)

    init {
        viewModelScope.launch {
            while (isActive) {
                if (prefs.pairing.value?.revoked == false) checkConnection()
                delay(20_000)
            }
        }
        refreshMedia()
    }

    fun defaultDeviceName(): String = listOf(Build.MANUFACTURER.replaceFirstChar(Char::uppercase), Build.MODEL)
        .distinct().joinToString(" ").take(60)

    fun pair(rawLink: String, deviceName: String) {
        if (busy.value) return
        busy.value = true
        message.value = null
        viewModelScope.launch {
            try {
                val link = PairingLinks.parse(rawLink)
                val claim = withContext(Dispatchers.IO) { PairingFlow.pair(link, deviceName.ifBlank { defaultDeviceName() }) }
                withContext(Dispatchers.IO) {
                    val now = System.currentTimeMillis()
                    val previous = prefs.previousFingerprint()
                    // Upload records belong to the old device credential; completed history is kept for the same desktop.
                    if (previous != null && previous != link.fingerprint) dao.resetAllForNewDesktop(now) else dao.forgetServerRecords(now)
                    prefs.savePairing(link.baseUrl, link.fingerprint, claim.deviceId, deviceName.ifBlank { defaultDeviceName() }, claim.token, now)
                }
                prefs.updateSettings { it.copy(paused = false) }
                SyncScheduler.apply(getApplication())
                checkConnection()
            } catch (error: Exception) {
                message.value = PairingFlow.describe(error)
            } finally {
                busy.value = false
            }
        }
    }

    fun disconnect() {
        val pairing = prefs.pairing.value ?: return
        busy.value = true
        viewModelScope.launch {
            val token = prefs.token()
            val revokedOnDesktop = withContext(Dispatchers.IO) {
                if (pairing.revoked || token == null) return@withContext true
                runCatching { SyncApi(pairing.baseUrl, PinnedHttp.client(pairing.fingerprint), token).revokeSelf() }.isSuccess
            }
            SyncScheduler.cancelAll(getApplication())
            prefs.clearPairing()
            connection.value = Connection.Unknown
            message.value = if (revokedOnDesktop) "Disconnected. Your backup history on this phone is kept."
            else "Disconnected on this phone. The desktop could not be reached, so also remove this phone in MiLeo on the PC."
            busy.value = false
        }
    }

    /** After the desktop revoked this phone: drop the dead credential so the user can scan a new code. */
    fun forgetRevokedPairing() {
        SyncScheduler.cancelAll(getApplication())
        prefs.clearPairing()
        connection.value = Connection.Unknown
    }

    fun checkConnection() {
        val pairing = prefs.pairing.value ?: return
        if (pairing.revoked) { connection.value = Connection.Revoked; return }
        val token = prefs.token() ?: return
        if (connection.value !is Connection.Online) connection.value = Connection.Checking
        viewModelScope.launch {
            connection.value = withContext(Dispatchers.IO) {
                try {
                    val api = SyncApi(pairing.baseUrl, PinnedHttp.client(pairing.fingerprint), token)
                    val ping = api.ping()
                    api.device()
                    Connection.Online(ping.appVersion)
                } catch (error: ApiException) {
                    if (error.isUnauthorized) { prefs.markRevoked(); SyncScheduler.cancelAll(getApplication()); Connection.Revoked }
                    else Connection.Offline(PairingFlow.describe(error))
                } catch (error: IOException) {
                    Connection.Offline(PairingFlow.describe(error))
                }
            }
        }
    }

    fun syncNow() {
        prefs.updateSettings { it.copy(paused = false) }
        SyncScheduler.syncNow(getApplication())
    }

    fun pause() {
        prefs.updateSettings { it.copy(paused = true) }
    }

    fun resume() {
        prefs.updateSettings { it.copy(paused = false) }
        SyncScheduler.apply(getApplication())
        SyncScheduler.syncNow(getApplication())
    }

    fun retryFailed() {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { dao.retryFailed(System.currentTimeMillis()) }
            syncNow()
        }
    }

    fun update(transform: (SyncSettings) -> SyncSettings) {
        val before = prefs.settings.value
        prefs.updateSettings(transform)
        val after = prefs.settings.value
        SyncScheduler.apply(getApplication())
        if (before.mediaSelection != after.mediaSelection || before.buckets != after.buckets) refreshMedia()
    }

    fun setMediaSelection(selection: MediaSelection) = update { it.copy(mediaSelection = selection) }

    fun toggleAlbum(bucketId: String) = update { current ->
        val next = if (bucketId in current.buckets) current.buckets - bucketId else current.buckets + bucketId
        // An empty set means "all albums", so the last selected album cannot be unticked.
        if (next.isEmpty()) current else current.copy(buckets = next)
    }

    /** Re-reads permissions, albums and the selected media into the queue (no upload). */
    fun refreshMedia() {
        access.value = readAccess()
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                albums.value = runCatching { scanner.albums() }.getOrDefault(emptyList())
                runCatching { SyncWorker.reconcile(getApplication(), scanner, prefs.settings.value) }
            }
        }
    }

    private fun readAccess() = Access(
        photos = MediaAccess.level(getApplication(), "image"),
        videos = MediaAccess.level(getApplication(), "video"),
        location = MediaAccess.hasLocation(getApplication()),
    )
}
