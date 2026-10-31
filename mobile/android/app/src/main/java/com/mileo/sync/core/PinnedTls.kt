package com.mileo.sync.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

/**
 * Trusts exactly one certificate: the desktop's self-signed certificate whose SHA-256 fingerprint arrived
 * out-of-band in the pairing QR code. No CA trust is involved, so a different LAN host cannot impersonate it.
 */
class PinnedCertificateTrustManager(fingerprint: String) : X509TrustManager {
    private val expected = PairingLinks.normalizeFingerprint(fingerprint)

    init {
        require(expected.length == 64) { "Invalid certificate fingerprint." }
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("Desktop sent no certificate.")
        if (fingerprintOf(leaf) != expected) {
            throw CertificateException("Desktop certificate does not match the paired fingerprint.")
        }
        leaf.checkValidity()
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not supported.")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    companion object {
        fun fingerprintOf(certificate: X509Certificate): String =
            MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
    }
}

object PinnedHttp {
    fun client(fingerprint: String, base: OkHttpClient = OkHttpClient()): OkHttpClient {
        val trustManager = PinnedCertificateTrustManager(fingerprint)
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), SecureRandom()) }
        return base.newBuilder()
            .sslSocketFactory(context.socketFactory, trustManager)
            // The certificate is pinned by fingerprint; the desktop's LAN IP can change, so the host name is not
            // compared. Instead, re-check the negotiated (possibly resumed) session's peer certificate against the pin.
            .hostnameVerifier { _, session ->
                val leaf = runCatching { session.peerCertificates.firstOrNull() as? X509Certificate }.getOrNull()
                leaf != null && PinnedCertificateTrustManager.fingerprintOf(leaf) == PairingLinks.normalizeFingerprint(fingerprint)
            }
            .connectTimeout(java.time.Duration.ofSeconds(10))
            .readTimeout(java.time.Duration.ofSeconds(60))
            .writeTimeout(java.time.Duration.ofSeconds(60))
            .build()
    }
}
