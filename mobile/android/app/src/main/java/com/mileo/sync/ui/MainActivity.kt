package com.mileo.sync.ui

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.mileo.sync.android.AccessLevel
import com.mileo.sync.android.MediaAccess
import com.mileo.sync.android.MediaSelection

class MainActivity : ComponentActivity() {
    private val model: SyncViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { App(model, ::scanQr) }
            }
        }
    }

    /** Google code scanner: the camera runs in Google Play services, so this app needs no CAMERA permission. */
    private fun scanQr(onResult: (String?, String?) -> Unit) {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { onResult(it.rawValue, null) }
            .addOnCanceledListener { onResult(null, null) }
            .addOnFailureListener { onResult(null, "QR scanner is unavailable on this phone. Paste the pairing link instead.") }
    }
}

@Composable
private fun App(model: SyncViewModel, scanQr: ((String?, String?) -> Unit) -> Unit) {
    val pairing by model.pairing.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        model.refreshMedia()
        model.checkConnection()
    }
    Scaffold { padding ->
        Column(
            Modifier.padding(padding).padding(horizontal = 16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.padding(top = 4.dp))
            Text("MiLeo Sync", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text("Back up this phone's photos and videos to your MiLeo Photo Library PC over your home Wi-Fi.",
                style = MaterialTheme.typography.bodyMedium)
            if (pairing == null) SetupScreen(model, scanQr) else HomeScreen(model)
            Spacer(Modifier.padding(bottom = 16.dp))
        }
    }
}

@Composable
private fun SetupScreen(model: SyncViewModel, scanQr: ((String?, String?) -> Unit) -> Unit) {
    val busy by model.busy.collectAsStateWithLifecycle()
    val message by model.message.collectAsStateWithLifecycle()
    var name by rememberSaveable { mutableStateOf(model.defaultDeviceName()) }
    var link by rememberSaveable { mutableStateOf("") }
    Section("Connect to your PC") {
        Text("1. On the PC, open MiLeo → Wi-Fi Sync, turn it on and choose “Pair a phone”.\n" +
            "2. Scan the QR code shown there. Codes are valid for a few minutes and work once.")
        OutlinedTextField(name, { name = it.take(60) }, label = { Text("Name for this phone") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Button(onClick = {
            scanQr { value, error ->
                if (value != null) { link = value; model.pair(value, name) } else if (error != null) model.message.value = error
            }
        }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Scan QR code") }
        OutlinedTextField(link, { link = it }, label = { Text("…or paste the pairing link") }, modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = { model.pair(link, name) }, enabled = !busy && link.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Pair with link") }
        if (busy) Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.padding(end = 8.dp)); Text("Connecting securely…")
        }
        message?.let { ErrorText(it) }
    }
    PrivacyNote()
}

@Composable
private fun HomeScreen(model: SyncViewModel) {
    val pairing by model.pairing.collectAsStateWithLifecycle()
    val connection by model.connection.collectAsStateWithLifecycle()
    val settings by model.settings.collectAsStateWithLifecycle()
    val counts by model.counts.collectAsStateWithLifecycle()
    val work by model.work.collectAsStateWithLifecycle()
    val albums by model.albums.collectAsStateWithLifecycle()
    val access by model.access.collectAsStateWithLifecycle()
    val lastSuccess by model.lastSuccessfulSync.collectAsStateWithLifecycle()
    val outcome by model.lastOutcome.collectAsStateWithLifecycle()
    val failed by model.failedItems.collectAsStateWithLifecycle()
    val message by model.message.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val current = pairing ?: return
    var confirmDisconnect by remember { mutableStateOf(false) }

    val mediaPermissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { model.refreshMedia() }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        model.update { it.copy(keepLocation = granted) }
        model.refreshMedia()
    }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    Section("Desktop") {
        Text(current.baseUrl.removePrefix("https://"), fontWeight = FontWeight.SemiBold)
        Text("This phone: ${current.deviceName}")
        Text("Paired ${relative(current.pairedAt)} · certificate ${current.fingerprint.take(8)}…${current.fingerprint.takeLast(4)}",
            style = MaterialTheme.typography.bodySmall)
        when (val state = connection) {
            is Connection.Online -> StatusText("● Connected" + (state.appVersion?.let { " (MiLeo $it)" } ?: ""), Color(0xFF2E7D32))
            is Connection.Offline -> { StatusText("● Desktop offline", Color(0xFFC62828)); Text(state.message, style = MaterialTheme.typography.bodySmall) }
            is Connection.Checking -> StatusText("● Checking…", Color.Gray)
            is Connection.Revoked -> {}
            is Connection.Unknown -> StatusText("● Not checked yet", Color.Gray)
        }
        if (current.revoked || connection is Connection.Revoked) {
            ErrorText("This phone was removed on the desktop, so it can no longer upload. Your photos on this phone are untouched.")
            Button(onClick = model::forgetRevokedPairing) { Text("Pair again") }
        } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = model::checkConnection) { Text("Check connection") }
            TextButton(onClick = { confirmDisconnect = true }, enabled = !busy) { Text("Disconnect") }
        }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }

    Section("Photo access") {
        Text("MiLeo Sync only reads the photos and videos you allow, to copy them to your PC. It never deletes or changes anything on this phone.",
            style = MaterialTheme.typography.bodySmall)
        AccessLine("Photos", access.photos, settings.mediaSelection != MediaSelection.VIDEOS)
        AccessLine("Videos", access.videos, settings.mediaSelection != MediaSelection.PHOTOS)
        val needed = (settings.mediaSelection != MediaSelection.VIDEOS && access.photos != AccessLevel.FULL) ||
            (settings.mediaSelection != MediaSelection.PHOTOS && access.videos != AccessLevel.FULL)
        if (needed) OutlinedButton(onClick = { mediaPermissions.launch(MediaAccess.permissionsFor(settings.mediaSelection)) }) {
            Text(if (access.photos == AccessLevel.PARTIAL || access.videos == AccessLevel.PARTIAL) "Change selection / allow all" else "Allow access")
        }
        if (Build.VERSION.SDK_INT >= 29) SwitchRow(
            "Keep photo location (GPS)",
            "Android removes location data from photos unless you allow it. Off = backups have no location.",
            settings.keepLocation && access.location,
        ) { on -> if (on && !access.location) locationPermission.launch(Manifest.permission.ACCESS_MEDIA_LOCATION) else model.update { it.copy(keepLocation = on) } }
    }

    Section("What to back up") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MediaSelection.entries.forEach { option ->
                FilterChip(selected = settings.mediaSelection == option, onClick = { model.setMediaSelection(option) },
                    label = { Text(option.name.lowercase().replaceFirstChar(Char::uppercase)) })
            }
        }
        Text("${counts.photos} photos and ${counts.videos} videos selected", fontWeight = FontWeight.SemiBold)
        Text(if (settings.buckets.isEmpty()) "All albums" else "${settings.buckets.size} album(s) selected", style = MaterialTheme.typography.bodySmall)
        albums.forEach { album ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = settings.buckets.isEmpty() || album.bucketId in settings.buckets, onCheckedChange = {
                    if (settings.buckets.isEmpty()) model.update { s -> s.copy(buckets = albums.map { it.bucketId }.toSet() - album.bucketId) }
                    else model.toggleAlbum(album.bucketId)
                })
                Text("${album.name} (${album.photos + album.videos})")
            }
        }
        if (settings.buckets.isNotEmpty()) TextButton(onClick = { model.update { it.copy(buckets = emptySet()) } }) { Text("Select all albums") }
    }

    Section("Backup rules") {
        SwitchRow("Automatic backup", "Back up new photos in the background when Android allows it. Off = only when you tap Sync now.", settings.autoBackup) { on ->
            model.update { it.copy(autoBackup = on) }; if (on) askNotifications()
        }
        SwitchRow("Wi-Fi only", "Don't use mobile data.", settings.wifiOnly) { on -> model.update { it.copy(wifiOnly = on) } }
        SwitchRow("Only while charging", "Save battery on large backups.", settings.chargingOnly) { on -> model.update { it.copy(chargingOnly = on) } }
        Text("Android decides when background work runs (at most every 15 minutes, later in battery saver or Doze). " +
            "Backups pause when the rules above are not met and continue later.", style = MaterialTheme.typography.bodySmall)
    }

    Section("Backup status") {
        Text("Pending ${counts.pending} · Uploading ${counts.uploading} · Completed ${counts.completed} · Skipped ${counts.skipped} · Failed ${counts.failed}")
        if (work.running) {
            Text((if (work.phase == "checking") "Checking " else "Uploading ") + (work.file ?: "…"))
            if (work.total > 0) LinearProgressIndicator(progress = { work.done.toFloat() / work.total }, modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(Modifier.fillMaxWidth())
        } else if (settings.paused) Text("Paused", fontWeight = FontWeight.SemiBold)
        else if (work.enqueued && counts.pending > 0) Text("Waiting for network, charging or the next retry…", style = MaterialTheme.typography.bodySmall)
        Text("Last successful sync: ${lastSuccess?.let(::relative) ?: "never"}")
        outcome?.let { Text("Last run: ${it.message}", style = MaterialTheme.typography.bodySmall, color = if (it.ok) Color.Unspecified else Color(0xFFC62828)) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val usable = !current.revoked && connection !is Connection.Revoked
            Button(onClick = { askNotifications(); model.syncNow() }, enabled = usable && !work.running) { Text("Sync now") }
            if (settings.paused) OutlinedButton(onClick = model::resume, enabled = usable) { Text("Resume") }
            else OutlinedButton(onClick = model::pause, enabled = usable) { Text("Pause") }
        }
        if (counts.failed > 0) {
            OutlinedButton(onClick = model::retryFailed) { Text("Retry ${counts.failed} failed") }
            failed.take(5).forEach { Text("• ${it.displayName}: ${it.lastError ?: "failed"}", style = MaterialTheme.typography.bodySmall) }
        }
    }
    PrivacyNote()

    if (confirmDisconnect) AlertDialog(
        onDismissRequest = { confirmDisconnect = false },
        title = { Text("Disconnect from this PC?") },
        text = { Text("Backups stop and this phone's credential is revoked. Photos already on the PC and on this phone are not deleted.") },
        confirmButton = { TextButton(onClick = { confirmDisconnect = false; model.disconnect() }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Cancel") } },
    )
    LaunchedEffect(current.revoked) { if (current.revoked) model.checkConnection() }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun SwitchRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(detail, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.width(8.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun AccessLine(label: String, level: AccessLevel, wanted: Boolean) {
    if (!wanted) return
    Text("$label: " + when (level) {
        AccessLevel.FULL -> "allowed"
        AccessLevel.PARTIAL -> "only items you selected (Android limited access)"
        AccessLevel.NONE -> "not allowed"
    })
}

@Composable
private fun StatusText(text: String, color: Color) = Text(text, color = color, fontWeight = FontWeight.SemiBold)

@Composable
private fun ErrorText(text: String) = Text(text, color = MaterialTheme.colorScheme.error)

@Composable
private fun PrivacyNote() {
    Text("Privacy: files go directly from this phone to your PC on your local network, encrypted and verified with SHA-256. " +
        "Nothing is sent to the internet, and MiLeo Sync never deletes photos or videos from this phone.",
        style = MaterialTheme.typography.bodySmall)
}

private fun relative(time: Long): String =
    DateUtils.getRelativeTimeSpanString(time, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
