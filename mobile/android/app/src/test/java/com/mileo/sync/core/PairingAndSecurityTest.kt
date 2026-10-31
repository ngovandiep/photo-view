package com.mileo.sync.core

import java.io.ByteArrayInputStream
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingLinkTest {
    private val fp = "62%3ABA%3AFF%3A50%3A17%3A20%3AD0%3A47%3AE2%3A01%3A54%3AE2%3A2A%3A04%3A1F%3A8F%3AF0%3AB1%3A03%3A68%3AC9%3AA0%3A27%3AF4%3A41%3AB8%3A59%3A22%3A28%3A22%3A7C%3A63"

    @Test fun parsesDesktopQrPayload() {
        val link = PairingLinks.parse("https://192.168.1.20:47321/app#code=H6SM4FQJ&fp=$fp&v=1")
        assertEquals("https://192.168.1.20:47321", link.baseUrl)
        assertEquals("H6SM4FQJ", link.code)
        assertEquals("62baff501720d047e20154e22a041f8ff0b10368c9a027f441b8592228227c63", link.fingerprint)
    }

    @Test fun rejectsInsecureOrPublicOrMalformedLinks() {
        val bad = listOf(
            "http://192.168.1.20:47321/app#code=H6SM4FQJ&fp=$fp&v=1",
            "https://8.8.8.8:47321/app#code=H6SM4FQJ&fp=$fp&v=1",
            "https://example.com:47321/app#code=H6SM4FQJ&fp=$fp&v=1",
            "https://192.168.1.20:47321/app#fp=$fp&v=1",
            "https://192.168.1.20:47321/app#code=../../x&fp=$fp&v=1",
            "https://192.168.1.20:47321/app#code=H6SM4FQJ&fp=abc&v=1",
            "https://192.168.1.20:47321/app#code=H6SM4FQJ&fp=$fp&v=2",
            "not a link at all",
            "",
        )
        for (value in bad) assertThrows(value, InvalidPairingLinkException::class.java) { PairingLinks.parse(value) }
    }

    @Test fun privateAddressRuleMatchesDesktop() {
        listOf("10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.0.10", "127.0.0.1", "169.254.1.1").forEach { assertTrue(it, PairingLinks.isPrivateIpv4(it)) }
        listOf("172.32.0.1", "11.0.0.1", "192.169.0.1", "256.1.1.1", "1.2.3", "a.b.c.d").forEach { assertFalse(it, PairingLinks.isPrivateIpv4(it)) }
    }
}

class PinnedTrustManagerTest {
    private fun resource(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.readBytes()
    private val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(resource("test-cert.pem"))) as X509Certificate
    private val fingerprint = String(resource("test-cert.fingerprint")).trim()

    @Test fun acceptsOnlyThePinnedCertificate() {
        PinnedCertificateTrustManager(fingerprint).checkServerTrusted(arrayOf(cert), "RSA")
        val other = "00".repeat(32)
        assertThrows(CertificateException::class.java) { PinnedCertificateTrustManager(other).checkServerTrusted(arrayOf(cert), "RSA") }
        assertThrows(CertificateException::class.java) { PinnedCertificateTrustManager(fingerprint).checkServerTrusted(emptyArray(), "RSA") }
    }

    @Test fun fingerprintFormatMatchesNodeFingerprint256() {
        assertEquals(PairingLinks.normalizeFingerprint(fingerprint), PinnedCertificateTrustManager.fingerprintOf(cert))
    }
}

class BackoffTest {
    @Test fun exponentialAndCapped() {
        assertEquals(0, Backoff.delayMs(0))
        assertEquals(30_000, Backoff.delayMs(1))
        assertEquals(60_000, Backoff.delayMs(2))
        assertEquals(120_000, Backoff.delayMs(3))
        assertEquals(3_600_000, Backoff.delayMs(9))
        assertEquals(3_600_000, Backoff.delayMs(500))
    }
}
