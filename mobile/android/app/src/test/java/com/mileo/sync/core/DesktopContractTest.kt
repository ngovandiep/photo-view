package com.mileo.sync.core

import com.mileo.sync.data.QueueState
import com.mileo.sync.data.QueuedAsset
import com.mileo.sync.data.SkipReason
import java.io.ByteArrayInputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.buffer
import okio.ForwardingSink
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/**
 * End-to-end tests of the Android upload engine against the real MiLeo desktop sync server (M1).
 * Run with: node tools/contract-server.cjs, then MILEO_CONTRACT_URL=<CONTROL_URL> gradlew :app:testDebugUnitTest.
 * Skipped when the property is not set.
 */
class DesktopContractTest {
    private val controlUrl: String? = System.getProperty("mileo.contractUrl")
    private val control = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    private val clock = AtomicLong(System.currentTimeMillis())

    @Serializable data class LinkDto(val link: String)
    @Serializable data class LibraryEntry(val path: String, val size: Long, val sha256: String? = null)

    @Before fun requireServer() {
        assumeTrue("MILEO_CONTRACT_URL not set; contract tests skipped", controlUrl != null)
        // A fresh server process state per test also resets the desktop's 10/min pairing rate limit.
        controlPost("/restart")
    }

    @After fun ensureStarted() {
        if (controlUrl != null) runCatching { controlPost("/start") }
    }

    private fun controlPost(path: String, body: String = "{}"): String =
        control.newCall(Request.Builder().url("$controlUrl$path").post(body.toRequestBody("application/json".toMediaType())).build()).execute().use { it.body!!.string() }

    private fun newLink(): PairingLink = PairingLinks.parse(json.decodeFromString(LinkDto.serializer(), controlPost("/pair")).link)

    private fun library(): List<LibraryEntry> =
        control.newCall(Request.Builder().url("$controlUrl/library").build()).execute().use { json.decodeFromString(it.body!!.string()) }

    private fun waitForLibrary(sha: String): LibraryEntry {
        repeat(50) {
            library().firstOrNull { it.sha256 == sha }?.let { return it }
            Thread.sleep(100)
        }
        throw AssertionError("File $sha never appeared in the library index")
    }

    private class Device(val link: PairingLink, val claim: ClaimDto, val http: OkHttpClient) {
        fun api(token: String = claim.token) = SyncApi(link.baseUrl, PinnedHttp.client(link.fingerprint, http), token)
    }

    private fun pairDevice(name: String, http: OkHttpClient = OkHttpClient()): Device {
        val link = newLink()
        return Device(link, PairingFlow.pair(link, name, "android", http), http)
    }

    private class MemoryQueue : UploadQueue {
        val rows = linkedMapOf<String, QueuedAsset>()
        override suspend fun resetInterrupted(now: Long) {
            rows.replaceAll { _, v -> if (v.state == QueueState.UPLOADING) v.copy(state = QueueState.PENDING) else v }
        }
        override suspend fun due(now: Long, limit: Int) = rows.values.filter { it.state == QueueState.PENDING && it.nextAttemptAt <= now }.take(limit)
        override suspend fun save(item: QueuedAsset) { rows[item.mediaKey] = item }
        operator fun get(key: String) = rows[key]!!
    }

    private class Phone {
        val queue = MemoryQueue()
        val files = HashMap<String, ByteArray>()
        /** Optional transform of bytes read during upload (after hashing), to simulate on-the-wire corruption. */
        var corruptUpload: ((ByteArray) -> ByteArray)? = null
        private val reads = HashMap<String, Int>()

        fun add(key: String, name: String, bytes: ByteArray, kind: String = "image", mime: String = "image/jpeg") {
            files[key] = bytes
            queue.rows[key] = QueuedAsset(
                mediaKey = key, uri = "test://$key", kind = kind, displayName = name, mimeType = mime,
                size = bytes.size.toLong(), dateModified = 1_700_000_000, capturedAt = 1_700_000_000_000,
                folderPath = "DCIM/Camera", bucketId = "cam",
            )
        }

        val reader = MediaReader { item ->
            val count = reads.merge(item.mediaKey, 1, Int::plus)!!
            val bytes = files[item.mediaKey] ?: throw java.io.FileNotFoundException(item.mediaKey)
            ByteArrayInputStream(if (count > 1) corruptUpload?.invoke(bytes) ?: bytes else bytes)
        }
    }

    /** Counts PUT body bytes and can cut the connection in the middle of a chosen PUT. */
    private class FlakyNetwork {
        val putBytes = AtomicLong()
        val puts = AtomicInteger()
        @Volatile var failPut: Int = -1
        @Volatile var failAfterBytes: Long = 0

        val client: OkHttpClient = OkHttpClient.Builder().addNetworkInterceptor(Interceptor { chain ->
            val request = chain.request()
            if (request.method != "PUT") return@Interceptor chain.proceed(request)
            val number = puts.incrementAndGet()
            val original = request.body!!
            val body = object : RequestBody() {
                override fun contentType(): MediaType? = original.contentType()
                override fun contentLength() = original.contentLength()
                override fun writeTo(sink: BufferedSink) {
                    val buffer = Buffer()
                    original.writeTo(buffer)
                    if (number == failPut) {
                        sink.write(buffer, failAfterBytes)
                        sink.flush()
                        putBytes.addAndGet(failAfterBytes)
                        throw IOException("simulated network loss")
                    }
                    putBytes.addAndGet(buffer.size)
                    sink.writeAll(buffer)
                }
            }
            chain.proceed(request.newBuilder().method("PUT", body).build())
        }).build()
    }

    private fun engine(device: Device, phone: Phone, api: SyncApi = device.api(), chunk: Int = 256 * 1024) =
        UploadEngine(api, phone.queue, phone.reader, clock = clock::get, chunkSize = chunk)

    /** Runs the engine like WorkManager would: retry after backoff until nothing is due. */
    private fun syncUntilIdle(device: Device, phone: Phone, maxRuns: Int = 8, chunk: Int = 256 * 1024): List<RunResult> = runBlocking {
        val results = ArrayList<RunResult>()
        repeat(maxRuns) {
            val result = engine(device, phone, chunk = chunk).run()
            results += result
            if (result is RunResult.NothingToDo) return@runBlocking results
            clock.addAndGet(Backoff.MAX_MS)
            Thread.sleep(200)
        }
        results
    }

    private fun jpeg(size: Int, seed: Int): ByteArray = ByteArray(size) { ((it * 31 + seed * 7) % 251).toByte() }.also {
        it[0] = 0xFF.toByte(); it[1] = 0xD8.toByte(); it[2] = 0xFF.toByte(); it[3] = 0xE0.toByte()
    }

    private fun mp4(size: Int, seed: Int): ByteArray = ByteArray(size) { ((it * 17 + seed) % 253).toByte() }.also {
        "\u0000\u0000\u0000\u0018ftypisom".toByteArray(Charsets.ISO_8859_1).copyInto(it)
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test fun twoDevicesPairAndUploadPhotosAndVideos() {
        val a = pairDevice("Pixel A")
        val b = pairDevice("Galaxy B")
        assertNotEquals(a.claim.deviceId, b.claim.deviceId)
        assertNotEquals(a.claim.token, b.claim.token)

        val photo = jpeg(300_000, 1)
        val video = mp4(700_000, 2)
        val phoneA = Phone().apply { add("a:1", "IMG_0001.jpg", photo); add("a:2", "VID_0002.mp4", video, "video", "video/mp4") }
        val phoneB = Phone().apply { add("b:1", "IMG_B.jpg", jpeg(120_000, 3)) }
        syncUntilIdle(a, phoneA)
        syncUntilIdle(b, phoneB)

        assertEquals(QueueState.COMPLETED, phoneA.queue["a:1"].state)
        assertEquals(QueueState.COMPLETED, phoneA.queue["a:2"].state)
        assertEquals(QueueState.COMPLETED, phoneB.queue["b:1"].state)
        assertTrue(waitForLibrary(sha(photo)).path.contains("DCIM/Camera"))
        waitForLibrary(sha(video))
        // The phone keeps every original: the engine only reads.
        assertEquals(sha(photo), sha(phoneA.files["a:1"]!!))
    }

    @Test fun interruptedUploadResumesFromServerOffset() {
        val network = FlakyNetwork().apply { failPut = 3; failAfterBytes = 100_000 }
        val device = pairDevice("Flaky", network.client)
        val big = jpeg(1_500_000, 4)
        val phone = Phone().apply { add("f:1", "IMG_BIG.jpg", big) }

        val first = runBlocking { engine(device, phone).run() }
        assertTrue("expected a dropped connection, got $first", first is RunResult.DesktopUnreachable)
        val afterDrop = phone.queue["f:1"]
        assertEquals(QueueState.PENDING, afterDrop.state)
        assertNotNull(afterDrop.serverAssetId)

        Thread.sleep(300)
        clock.addAndGet(Backoff.MAX_MS) // the backoff WorkManager would wait out before retrying
        val runs = syncUntilIdle(device, phone)
        assertEquals("runs=$runs item=${phone.queue["f:1"]}", QueueState.COMPLETED, phone.queue["f:1"].state)
        val entry = waitForLibrary(sha(big))
        assertEquals(big.size.toLong(), entry.size)
        // Resumed rather than restarted: total bytes on the wire are well under two full copies.
        assertTrue("sent ${network.putBytes.get()} bytes", network.putBytes.get() < big.size + 600_000)
    }

    @Test fun duplicatesAndRepeatsDoNotCreateNewLibraryAssets() {
        val a = pairDevice("Dup A")
        val b = pairDevice("Dup B")
        val photo = jpeg(200_000, 5)
        val phoneA = Phone().apply { add("d:1", "IMG_D.jpg", photo) }
        syncUntilIdle(a, phoneA)
        waitForLibrary(sha(photo))
        val before = library().count { it.sha256 == sha(photo) }

        // Same content from another phone: stored once, reported as duplicate.
        val phoneB = Phone().apply { add("d:9", "copy.jpg", photo) }
        syncUntilIdle(b, phoneB)
        assertEquals(QueueState.COMPLETED, phoneB.queue["d:9"].state)
        assertEquals("duplicate", phoneB.queue["d:9"].serverStatus)

        // The same phone item re-queued (for example, app data cleared): no bytes re-sent.
        val network = FlakyNetwork()
        val again = Device(a.link, a.claim, network.client)
        phoneA.queue.rows["d:1"] = phoneA.queue["d:1"].copy(state = QueueState.PENDING, serverAssetId = null)
        syncUntilIdle(again, phoneA)
        assertEquals(QueueState.COMPLETED, phoneA.queue["d:1"].state)
        assertEquals(0L, network.putBytes.get())
        Thread.sleep(300)
        assertEquals(before, library().count { it.sha256 == sha(photo) })
    }

    @Test fun pendingWorkAndHistorySurviveDesktopRestartAndOutage() {
        val network = FlakyNetwork().apply { failPut = 2; failAfterBytes = 50_000 }
        val device = pairDevice("Restart", network.client)
        val photo = jpeg(900_000, 6)
        val phone = Phone().apply { add("r:1", "IMG_R.jpg", photo) }
        assertTrue(runBlocking { engine(device, phone).run() } is RunResult.DesktopUnreachable)
        val assetId = phone.queue["r:1"].serverAssetId!!

        controlPost("/restart")
        val state = device.api().uploadState(assetId)
        assertTrue("server kept the partial upload: $state", state.offset > 0)

        controlPost("/stop")
        clock.addAndGet(Backoff.MAX_MS)
        assertTrue(runBlocking { engine(device, phone).run() } is RunResult.DesktopUnreachable)
        assertEquals(QueueState.PENDING, phone.queue["r:1"].state)

        controlPost("/start")
        syncUntilIdle(device, phone)
        assertEquals(QueueState.COMPLETED, phone.queue["r:1"].state)
        assertEquals(assetId, phone.queue["r:1"].serverAssetId)
        assertTrue(device.api().asset(assetId).isSafelyStored)
        waitForLibrary(sha(photo))
    }

    @Test fun invalidAndRevokedCredentialsCannotUpload() {
        val device = pairDevice("Revoke me")
        val phone = Phone().apply { add("x:1", "IMG_X.jpg", jpeg(10_000, 7)) }
        val forged = runBlocking { engine(device, phone, api = device.api(token = "not-a-real-token")).run() }
        assertEquals(RunResult.Unauthorized, forged)
        assertEquals(QueueState.PENDING, phone.queue["x:1"].state)

        controlPost("/revoke", """{"deviceId":"${device.claim.deviceId}"}""")
        assertEquals(RunResult.Unauthorized, runBlocking { engine(device, phone).run() })
        assertNull(library().firstOrNull { it.sha256 == sha(phone.files["x:1"]!!) })
    }

    @Test fun pairingRejectsWrongCertificateAndReusedCode() {
        val link = newLink()
        val forged = link.copy(fingerprint = "ab".repeat(32))
        val error = runCatching { PairingFlow.pair(forged, "Mallory") }.exceptionOrNull()
        assertNotNull(error)
        assertTrue(PairingFlow.describe(error!!), PairingFlow.describe(error).contains("certificate"))

        PairingFlow.pair(link, "First")
        val reuse = assertThrows(ApiException::class.java) { PairingFlow.pair(link, "Second") }
        assertEquals("invalid_code", reuse.code)
    }

    @Test fun corruptedContentFailsIntegrityCheckAndIsNotImported() {
        val device = pairDevice("Corrupt")
        val photo = jpeg(400_000, 8)
        val phone = Phone().apply {
            add("c:1", "IMG_C.jpg", photo)
            corruptUpload = { bytes -> bytes.copyOf().also { it[200_000] = (it[200_000] + 1).toByte() } }
        }
        syncUntilIdle(device, phone)
        val item = phone.queue["c:1"]
        assertEquals(QueueState.FAILED, item.state)
        assertTrue(item.lastError!!, item.lastError!!.contains("rejected"))
        Thread.sleep(300)
        val bad = phone.corruptUpload!!(photo)
        assertFalse(library().any { it.sha256 == sha(photo) || it.sha256 == sha(bad) })
    }

    @Test fun malformedAndUnsupportedFilenamesAreHandledSafely() {
        val device = pairDevice("Names")
        val photo = jpeg(50_000, 9)
        val phone = Phone().apply {
            add("n:1", "../../..\\evil<>:name.jpg", photo)
            add("n:2", "payload.exe", ByteArray(1000) { 1 }, mime = "application/octet-stream")
        }
        syncUntilIdle(device, phone)
        assertEquals(QueueState.COMPLETED, phone.queue["n:1"].state)
        val entry = waitForLibrary(sha(photo))
        assertFalse(entry.path, entry.path.contains(".."))
        assertFalse(entry.path, entry.path.contains("<") || entry.path.contains(":") || entry.path.contains("\\"))
        assertEquals(QueueState.SKIPPED, phone.queue["n:2"].state)
        assertEquals(SkipReason.UNSUPPORTED, phone.queue["n:2"].skipReason)
    }
}
