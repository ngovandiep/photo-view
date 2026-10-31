package com.mileo.sync.core

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import okhttp3.OkHttpClient

object PairingFlow {
    const val SERVICE = "still-wifi-sync"

    /** Verifies the pinned desktop identity, then exchanges the one-time code for a per-device credential. */
    fun pair(link: PairingLink, deviceName: String, platform: String = "android", base: OkHttpClient = OkHttpClient()): ClaimDto {
        val api = SyncApi(link.baseUrl, PinnedHttp.client(link.fingerprint, base))
        val ping = api.ping()
        if (ping.service != SERVICE || ping.apiVersion != 1) throw IOException("The address in the QR code is not a compatible MiLeo desktop.")
        return api.claim(link.code, deviceName.trim().take(60), platform)
    }

    /** Short, actionable explanation for a pairing or connection error. */
    fun describe(error: Throwable): String {
        var cause: Throwable? = error
        while (cause != null) {
            if (cause is CertificateException) {
                return "The desktop's security certificate does not match the QR code. Make sure you scanned the code on your own PC."
            }
            cause = cause.cause
        }
        return when (error) {
            is InvalidPairingLinkException -> error.message ?: "Invalid pairing code."
            is ApiException -> when {
                error.code == "invalid_code" -> "This pairing code expired or was already used. Create a new code on the desktop."
                error.code == "rate_limited" -> "Too many attempts. Wait a minute and try again."
                error.isUnauthorized -> "This phone was removed on the desktop. Pair again."
                else -> error.message ?: "The desktop rejected the request."
            }
            is SSLException -> "A secure connection to the desktop could not be established."
            is ConnectException, is SocketTimeoutException, is UnknownHostException ->
                "Cannot reach the desktop. Check that MiLeo is open with Wi-Fi Sync turned on and that this phone is on the same Wi-Fi."
            is IOException -> error.message ?: "Network error."
            else -> error.message ?: "Something went wrong."
        }
    }
}
