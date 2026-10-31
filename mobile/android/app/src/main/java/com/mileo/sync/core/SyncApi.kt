package com.mileo.sync.core

import java.io.IOException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Error reported by the desktop (`{error:{code,message}}`). Network failures surface as [IOException] instead. */
class ApiException(val status: Int, val code: String, message: String, val uploadOffset: Long? = null) : Exception(message) {
    val isUnauthorized get() = status == 401
}

@Serializable data class PingDto(val service: String, val apiVersion: Int, val appVersion: String? = null, val tls: Boolean = false)
@Serializable data class ClaimDto(val deviceId: String, val token: String, val apiVersion: Int = 1)
@Serializable data class DeviceDto(val id: String, val name: String, val platform: String? = null, val lastSyncAt: Long? = null)
@Serializable data class SessionDto(val id: String, val status: String)

@Serializable
data class AssetDto(
    val id: String,
    val sourceAssetId: String,
    val filename: String? = null,
    val state: String,
    val status: String? = null,
    val size: Long = 0,
    val bytesReceived: Long = 0,
    val sha256: String? = null,
    val duplicateOf: String? = null,
    val error: String? = null,
) {
    /** `stored` and `indexed` mean the desktop has verified and committed the original file. */
    val isSafelyStored get() = state == "stored" || state == "indexed"
    val isClosed get() = state == "failed_permanent" || state == "cancelled"
}

@Serializable
data class AssetRegistration(
    val sourceAssetId: String,
    val filename: String,
    val mediaType: String,
    val size: Long,
    val capturedAt: Long? = null,
    val folderPath: String? = null,
    val sha256: String? = null,
)

@Serializable data class ErrorBody(val code: String = "error", val message: String = "Request failed.")
@Serializable data class RegisterResult(val sourceAssetId: String, val asset: AssetDto? = null, val error: ErrorBody? = null)
@Serializable internal data class RegisterBody(val assets: List<AssetRegistration>)
@Serializable internal data class RegisterResults(val assets: List<RegisterResult>)

data class UploadState(val offset: Long, val length: Long, val state: String)

sealed interface ChunkResult {
    data class Accepted(val asset: AssetDto, val offset: Long) : ChunkResult
    data class OffsetMismatch(val expectedOffset: Long) : ChunkResult
}

/** Client for the desktop `/api/v1` sync API. All calls are blocking; run them off the main thread. */
class SyncApi(private val baseUrl: String, private val http: OkHttpClient, private val token: String? = null) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val jsonType = "application/json".toMediaType()
    private val octets = "application/octet-stream".toMediaType()

    fun ping(): PingDto = call(get("/ping"), PingDto.serializer())

    fun claim(code: String, deviceName: String, platform: String): ClaimDto {
        val body = json.encodeToString(mapOf("code" to code, "deviceName" to deviceName, "platform" to platform))
        return call(post("/pairing/claim", body.toRequestBody(jsonType)), ClaimDto.serializer())
    }

    fun device(): DeviceDto = call(get("/device"), DeviceDto.serializer())

    fun revokeSelf() {
        execute(request("/device").delete().build()).close()
    }

    fun createSession(idempotencyKey: String): SessionDto =
        call(post("/sessions", "{}".toRequestBody(jsonType)).newBuilder().header("Idempotency-Key", idempotencyKey).build(), SessionDto.serializer())

    fun registerAssets(sessionId: String, assets: List<AssetRegistration>): List<RegisterResult> {
        val body = json.encodeToString(RegisterBody(assets)).toRequestBody(jsonType)
        return call(post("/sessions/$sessionId/assets", body), RegisterResults.serializer()).assets
    }

    fun asset(assetId: String): AssetDto = call(get("/assets/$assetId"), AssetDto.serializer())

    fun uploadState(assetId: String): UploadState = execute(request("/assets/$assetId/content").head().build()).use { response ->
        UploadState(
            offset = response.header("Upload-Offset")?.toLongOrNull() ?: 0,
            length = response.header("Upload-Length")?.toLongOrNull() ?: 0,
            state = response.header("Upload-State").orEmpty(),
        )
    }

    fun putChunk(assetId: String, offset: Long, body: RequestBody): ChunkResult {
        val request = request("/assets/$assetId/content")
            .put(body)
            .header("Upload-Offset", offset.toString())
            .build()
        val response = try {
            execute(request)
        } catch (error: ApiException) {
            if (error.status == 409 && error.code == "offset_mismatch" && error.uploadOffset != null) {
                return ChunkResult.OffsetMismatch(error.uploadOffset)
            }
            throw error
        }
        return response.use {
            val asset = json.decodeFromString(AssetDto.serializer(), it.body!!.string())
            ChunkResult.Accepted(asset, it.header("Upload-Offset")?.toLongOrNull() ?: asset.bytesReceived)
        }
    }

    fun completeSession(sessionId: String): SessionDto =
        call(post("/sessions/$sessionId/complete", "{}".toRequestBody(jsonType)), SessionDto.serializer())

    fun octetBody(bytes: ByteArray, offset: Int = 0, count: Int = bytes.size): RequestBody = bytes.toRequestBody(octets, offset, count)

    private fun request(path: String): Request.Builder {
        val builder = Request.Builder().url("$baseUrl/api/v1$path")
        if (token != null) builder.header("Authorization", "Bearer $token")
        return builder
    }

    private fun get(path: String) = request(path).get().build()
    private fun post(path: String, body: RequestBody) = request(path).post(body).build()

    private fun <T> call(request: Request, serializer: kotlinx.serialization.KSerializer<T>): T =
        execute(request).use { json.decodeFromString(serializer, it.body!!.string()) }

    private fun execute(request: Request): Response {
        val response = http.newCall(request).execute()
        if (response.isSuccessful) return response
        response.use {
            val text = it.body?.string().orEmpty()
            val error = runCatching { json.decodeFromString(ErrorWrapper.serializer(), text).error }.getOrNull()
            throw ApiException(
                status = it.code,
                code = error?.code ?: "http_${it.code}",
                message = error?.message ?: "Desktop returned HTTP ${it.code}.",
                uploadOffset = it.header("Upload-Offset")?.toLongOrNull(),
            )
        }
    }

    @Serializable private data class ErrorWrapper(@SerialName("error") val error: ErrorBody)
}
