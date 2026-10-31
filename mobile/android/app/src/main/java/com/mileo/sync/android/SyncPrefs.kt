package com.mileo.sync.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Encrypts the per-device credential with a non-exportable Android Keystore AES-GCM key. */
private object TokenCipher {
    private const val ALIAS = "mileo_device_token"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    fun decrypt(encoded: String): String? = runCatching {
        val sealed = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
        String(cipher.doFinal(sealed, 12, sealed.size - 12), Charsets.UTF_8)
    }.getOrNull()
}

data class Pairing(
    val baseUrl: String,
    val fingerprint: String,
    val deviceId: String,
    val deviceName: String,
    val pairedAt: Long,
    val revoked: Boolean,
)

enum class MediaSelection { PHOTOS, VIDEOS, BOTH }

data class SyncSettings(
    val mediaSelection: MediaSelection = MediaSelection.BOTH,
    /** MediaStore bucket ids; empty means all albums. */
    val buckets: Set<String> = emptySet(),
    val autoBackup: Boolean = false,
    val wifiOnly: Boolean = true,
    val chargingOnly: Boolean = false,
    val paused: Boolean = false,
    val keepLocation: Boolean = false,
)

data class SyncOutcome(val at: Long, val message: String, val ok: Boolean)

/** Pairing, settings and last-sync status. Small values only; the queue lives in Room. */
class SyncPrefs private constructor(context: Context) {
    private val prefs = context.getSharedPreferences("mileo_sync", Context.MODE_PRIVATE)
    private val _pairing = MutableStateFlow(readPairing())
    private val _settings = MutableStateFlow(readSettings())
    private val _lastSuccess = MutableStateFlow(prefs.getLong("last_success", 0).takeIf { it > 0 })
    private val _lastOutcome = MutableStateFlow(readOutcome())

    val pairing: StateFlow<Pairing?> = _pairing.asStateFlow()
    val settings: StateFlow<SyncSettings> = _settings.asStateFlow()
    val lastSuccessfulSync: StateFlow<Long?> = _lastSuccess.asStateFlow()
    val lastOutcome: StateFlow<SyncOutcome?> = _lastOutcome.asStateFlow()

    fun token(): String? = prefs.getString("token", null)?.let(TokenCipher::decrypt)

    /** Fingerprint of the last desktop this phone was paired with (kept after disconnecting). */
    fun previousFingerprint(): String? = prefs.getString("fingerprint", null)

    fun savePairing(baseUrl: String, fingerprint: String, deviceId: String, deviceName: String, token: String, now: Long) {
        prefs.edit()
            .putString("base_url", baseUrl).putString("fingerprint", fingerprint).putString("device_id", deviceId)
            .putString("device_name", deviceName).putString("token", TokenCipher.encrypt(token))
            .putLong("paired_at", now).putBoolean("revoked", false).apply()
        _pairing.value = readPairing()
    }

    fun markRevoked() {
        prefs.edit().putBoolean("revoked", true).apply()
        _pairing.value = readPairing()
    }

    /** Removes the credential; keeps the desktop fingerprint so re-pairing with the same desktop keeps queue history. */
    fun clearPairing() {
        prefs.edit().remove("base_url").remove("device_id").remove("token").remove("paired_at").remove("revoked").apply()
        _pairing.value = null
    }

    fun updateSettings(transform: (SyncSettings) -> SyncSettings) {
        val next = transform(_settings.value)
        prefs.edit()
            .putString("media", next.mediaSelection.name).putStringSet("buckets", next.buckets)
            .putBoolean("auto", next.autoBackup).putBoolean("wifi_only", next.wifiOnly)
            .putBoolean("charging_only", next.chargingOnly).putBoolean("paused", next.paused)
            .putBoolean("keep_location", next.keepLocation).apply()
        _settings.value = next
    }

    fun recordOutcome(outcome: SyncOutcome) {
        val edit = prefs.edit().putLong("outcome_at", outcome.at).putString("outcome_msg", outcome.message).putBoolean("outcome_ok", outcome.ok)
        if (outcome.ok) edit.putLong("last_success", outcome.at)
        edit.apply()
        _lastOutcome.value = outcome
        if (outcome.ok) _lastSuccess.value = outcome.at
    }

    private fun readPairing(): Pairing? {
        val url = prefs.getString("base_url", null) ?: return null
        if (!prefs.contains("token")) return null
        return Pairing(
            baseUrl = url,
            fingerprint = prefs.getString("fingerprint", "")!!,
            deviceId = prefs.getString("device_id", "")!!,
            deviceName = prefs.getString("device_name", "")!!,
            pairedAt = prefs.getLong("paired_at", 0),
            revoked = prefs.getBoolean("revoked", false),
        )
    }

    private fun readSettings() = SyncSettings(
        mediaSelection = runCatching { MediaSelection.valueOf(prefs.getString("media", null)!!) }.getOrDefault(MediaSelection.BOTH),
        buckets = prefs.getStringSet("buckets", emptySet())!!.toSet(),
        autoBackup = prefs.getBoolean("auto", false),
        wifiOnly = prefs.getBoolean("wifi_only", true),
        chargingOnly = prefs.getBoolean("charging_only", false),
        paused = prefs.getBoolean("paused", false),
        keepLocation = prefs.getBoolean("keep_location", false),
    )

    private fun readOutcome(): SyncOutcome? {
        val at = prefs.getLong("outcome_at", 0).takeIf { it > 0 } ?: return null
        return SyncOutcome(at, prefs.getString("outcome_msg", "")!!, prefs.getBoolean("outcome_ok", false))
    }

    companion object {
        @Volatile private var instance: SyncPrefs? = null
        fun get(context: Context): SyncPrefs = instance ?: synchronized(this) {
            instance ?: SyncPrefs(context.applicationContext).also { instance = it }
        }
    }
}
