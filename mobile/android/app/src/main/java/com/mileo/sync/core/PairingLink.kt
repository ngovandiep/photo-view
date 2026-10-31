package com.mileo.sync.core

import java.net.URI
import java.net.URLDecoder

/** Parsed desktop pairing QR: `https://<lan-ip>:<port>/app#code=<code>&fp=<sha256 cert fingerprint>&v=1`. */
data class PairingLink(
    val baseUrl: String,
    val host: String,
    val port: Int,
    val code: String,
    /** Lower-case hex SHA-256 of the desktop TLS certificate (DER), without separators. */
    val fingerprint: String,
)

class InvalidPairingLinkException(message: String) : IllegalArgumentException(message)

object PairingLinks {
    private val CODE = Regex("^[A-Za-z0-9-]{4,64}$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    fun parse(raw: String): PairingLink {
        val uri = try {
            URI(raw.trim())
        } catch (_: Exception) {
            throw InvalidPairingLinkException("This is not a MiLeo pairing code.")
        }
        if (!uri.scheme.equals("https", ignoreCase = true)) {
            throw InvalidPairingLinkException("The pairing code must use a secure (https) desktop address.")
        }
        val host = uri.host ?: throw InvalidPairingLinkException("The pairing code has no desktop address.")
        if (!isPrivateIpv4(host)) {
            throw InvalidPairingLinkException("The desktop address must be on your local network.")
        }
        val port = if (uri.port in 1..65535) uri.port else 443
        val params = (uri.rawFragment ?: "").split('&').filter { it.isNotEmpty() }.associate { part ->
            val key = part.substringBefore('=')
            val value = URLDecoder.decode(part.substringAfter('=', ""), "UTF-8")
            key to value
        }
        if (params["v"] != "1") throw InvalidPairingLinkException("This pairing code needs a newer version of MiLeo Sync.")
        val code = params["code"].orEmpty()
        if (!CODE.matches(code)) throw InvalidPairingLinkException("The pairing code is missing or malformed.")
        val fingerprint = normalizeFingerprint(params["fp"].orEmpty())
        if (!HEX64.matches(fingerprint)) {
            throw InvalidPairingLinkException("The pairing code has no valid security fingerprint.")
        }
        return PairingLink("https://$host:$port", host, port, code, fingerprint)
    }

    fun normalizeFingerprint(value: String): String = value.replace(":", "").replace(" ", "").lowercase()

    /** Mirrors the desktop server's private-address rule for IPv4 (the server only binds to LAN IPv4). */
    fun isPrivateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { part ->
            if (part.isEmpty() || part.length > 3 || !part.all(Char::isDigit)) return false
            part.toInt().also { if (it > 255) return false }
        }
        val (a, b) = octets
        return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
    }
}
