package com.mobilevision.android.network

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

data class Pairing(val address: String, val computerId: String, val name: String, val fingerprint: String, val token: String, val expiresAt: Long) {
    companion object {
        fun parse(text: String): Pairing {
            require(text.length <= 4096) { "配对内容过长" }
            val json = JSONObject(text)
            require(json.getInt("version") == 1) { "不支持此配对协议" }
            val uri = URI(json.getString("address"))
            require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/") && uri.port in 1..65535) { "电脑地址无效，必须为 HTTPS 地址" }
            val id = json.getString("computerId"); UUID.fromString(id)
            val fingerprint = json.getString("certificateSha256")
            require(fingerprint.matches(Regex("[0-9a-f]{64}"))) { "证书指纹无效" }
            return Pairing(json.getString("address").trimEnd('/'), id, json.getString("computerName").take(80), fingerprint, json.optString("token"), json.optLong("expiresAt"))
        }
    }
}
data class Session(val address: String, val computerId: String, val name: String, val fingerprint: String, val credential: String) {
    fun json() = JSONObject().put("address", address).put("computerId", computerId).put("name", name).put("fingerprint", fingerprint).put("credential", credential).toString()
    companion object { fun parse(text: String): Session { val j = JSONObject(text); return Session(j.getString("address"), j.getString("computerId"), j.getString("name"), j.getString("fingerprint"), j.getString("credential")) } }
}
class ApiFailure(val code: String, val retryable: Boolean) : IOException(code)
fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
fun fileHash(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

class ReceiverApi(private val address: String, private val fingerprint: String) {
    private val host = URI(address).host
    private val trust = object : X509TrustManager {
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) { throw CertificateException("Client certificates unsupported") }
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val cert = chain?.firstOrNull() ?: throw CertificateException("No certificate")
            cert.checkValidity()
            if (sha256(cert.encoded) != fingerprint) throw CertificateException("Certificate fingerprint mismatch")
        }
    }
    private val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    internal val client = OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust).hostnameVerifier { requested, session ->
        requested == host && runCatching { sha256(session.peerCertificates.first().encoded) == fingerprint }.getOrDefault(false)
    }.followRedirects(false).followSslRedirects(false).connectTimeout(5, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS).callTimeout(90, TimeUnit.SECONDS).build()

    private fun request(method: String, path: String, credential: String = "", body: RequestBody? = null, headers: Map<String, String> = emptyMap()): JSONObject {
        val builder = Request.Builder().url(address + "/api/v1" + path).method(method, body)
        if (credential.isNotEmpty()) builder.header("Authorization", "Bearer " + credential)
        headers.forEach { (key, value) -> builder.header(key, value) }
        client.newCall(builder.build()).execute().use { response ->
            val source = response.body?.source() ?: throw ApiFailure("EMPTY_RESPONSE", false)
            source.request(65537)
            if (source.buffer.size > 65536) throw ApiFailure("RESPONSE_TOO_LARGE", false)
            val json = try { JSONObject(source.readUtf8()) } catch (_: Exception) { throw ApiFailure("INVALID_RESPONSE", false) }
            if (!response.isSuccessful) {
                val code = json.optJSONObject("error")?.optString("code") ?: "HTTP_" + response.code
                throw ApiFailure(code, code == "RECEIVER_BUSY" || response.code == 429 || response.code == 503 || (response.code >= 500 && code !in setOf("DISK_FULL", "DIRECTORY_UNAVAILABLE")))
            }
            return json
        }
    }
    fun pair(pairing: Pairing, deviceId: String, deviceName: String, proposedCredential: String = ""): Session {
        require(pairing.token.isNotBlank() && pairing.expiresAt > System.currentTimeMillis()) { "二维码已过期，请在电脑刷新" }
        val body = JSONObject().apply { if (proposedCredential.isNotEmpty()) put("credential", proposedCredential) }.put("token", pairing.token).put("deviceId", deviceId).put("deviceName", deviceName.take(80)).toString().toRequestBody("application/json".toMediaType())
        val response = request("POST", "/pair", body = body)
        require(response.getString("computerId") == pairing.computerId && response.getInt("version") == 1) { "电脑身份不匹配" }
        val credential = response.getString("credential"); require(credential.matches(Regex("[0-9a-f]{64}"))) { "配对响应无效" }
        return Session(address, pairing.computerId, pairing.name, fingerprint, credential)
    }
    fun reconnect(session: Session, pairing: Pairing): Session {
        require(session.computerId == pairing.computerId && session.fingerprint == pairing.fingerprint) { "不是原配对电脑，无法更新地址" }
        val updated = session.copy(address = pairing.address, name = pairing.name)
        status(updated)
        return updated
    }
    fun status(session: Session) {
        val json = request("GET", "/status", session.credential)
        if (json.optString("computerId") != session.computerId) throw ApiFailure("COMPUTER_CHANGED", false)
    }
    fun upload(session: Session, id: String, file: File, capturedAt: String, hash: String, paste: Boolean = false) {
        val png = file.inputStream().use { input -> val signature = ByteArray(8); input.read(signature) == 8 && signature.contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)) }
        val response = request("PUT", "/photos/" + id, session.credential, file.asRequestBody((if (png) "image/png" else "image/jpeg").toMediaType()), mapOf("X-Content-Sha256" to hash, "X-Captured-At" to capturedAt, "X-Paste-After-Receive" to if (paste) "1" else "0"))
        try { UUID.fromString(response.getString("id")); require(response.getString("receivedAt").isNotBlank()) } catch (_: Exception) { throw ApiFailure("INVALID_CONFIRMATION", false) }
    }
}
