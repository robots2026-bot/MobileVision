package com.mobilevision.android

import android.app.Application
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import com.mobilevision.android.data.Photo
import com.mobilevision.android.data.PhotoStore
import com.mobilevision.android.data.SessionVault
import com.mobilevision.android.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

data class PhotoState(val ready: Boolean = false, val session: Session? = null, val photos: List<Photo> = emptyList(), val online: Boolean = false, val pairing: Boolean = false, val capturing: Boolean = false, val message: String = "正在加载…")

class PhotoViewModel(application: Application) : AndroidViewModel(application) {
    private val store = PhotoStore(application)
    private val vault = SessionVault(application)
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val mutable = MutableStateFlow(PhotoState())
    val state = mutable.asStateFlow()
    @Volatile private var foreground = false
    private var session: Session? = null
    private var api: ReceiverApi? = null
    private var lastHeartbeat = 0L
    private var blocked = false
    init {
        worker.execute {
            var note = "请扫描电脑上的配对二维码"
            try { session = vault.load(); session?.let { api = ReceiverApi(it.address, it.fingerprint); note = "等待连接电脑" } } catch (_: Exception) { note = "无法读取配对信息，请重新扫码" }
            for (photo in store.list()) {
                if (photo.state == "uploading") store.update(photo.id, "pending", photo.attempts, error = "上次传输中断，等待重试")
                if (photo.state == "capturing") {
                    val file = store.file(photo.id)
                    val temporary = store.temporary(photo.id)
                    if (!file.exists() && validPhoto(temporary)) temporary.renameTo(file)
                    if (file.exists() && validPhoto(file)) store.update(photo.id, "pending", hash = fileHash(file))
                    else { store.temporary(photo.id).delete(); store.update(photo.id, "capture_failed", error = "上次拍摄中断，请重新拍摄") }
                }
            }
            mutable.value = PhotoState(ready = true, session = session, photos = store.list(), message = note)
        }
        worker.scheduleWithFixedDelay({ runCatching { tick() }.onFailure { publish(message = "本地队列错误，请重启后重试") } }, 1, 1, TimeUnit.SECONDS)
    }
    fun foreground(value: Boolean) { foreground = value }
    private fun publish(message: String = mutable.value.message, online: Boolean = mutable.value.online) { mutable.value = mutable.value.copy(session = session, photos = store.list(), message = message, online = online) }
    fun pair(text: String) {
        if (mutable.value.pairing) return
        mutable.value = mutable.value.copy(pairing = true, message = "正在安全连接电脑…")
        worker.execute {
            try {
                val pairing = Pairing.parse(text)
                val client = ReceiverApi(pairing.address, pairing.fingerprint)
                val current = session
                val result = if (current != null) client.reconnect(current, pairing) else {
                    val pending = vault.load("pending")?.takeIf { it.computerId == pairing.computerId && it.fingerprint == pairing.fingerprint }
                    val candidate = pending?.copy(address = pairing.address) ?: Session(pairing.address, pairing.computerId, pairing.name, pairing.fingerprint, java.security.SecureRandom().let { random -> ByteArray(32).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) } })
                    vault.save(candidate, "pending")
                    if (pending != null && runCatching { client.status(candidate) }.isSuccess) candidate else client.pair(pairing, vault.deviceId(), Build.MODEL, candidate.credential)
                }
                vault.save(result); vault.clearPending(); session = result; api = client; blocked = false; lastHeartbeat = 0
                publish("配对成功，拍照后会自动上传", true)
            } catch (error: Exception) { publish(userMessage(error), false) }
            finally { mutable.value = mutable.value.copy(pairing = false) }
        }
    }
    fun disconnect() { worker.execute { vault.clear(); session = null; api = null; blocked = false; publish("已断开；本地照片仍保留。重新连接请在电脑解除配对后扫码。", false) } }
    fun retry() { worker.execute { session?.let { store.retry(it.computerId) }; blocked = false; lastHeartbeat = 0; publish("正在重新连接…") } }
    fun cleanSent() { worker.execute { val count = store.deleteSent(); publish("已清理 " + count + " 张已传照片，仅清理手机副本") } }
    fun beginCapture(callback: (String, File) -> Unit) {
        if (mutable.value.capturing) return
        mutable.value = mutable.value.copy(capturing = true)
        worker.execute {
            try {
                val target = session ?: throw IllegalStateException("请先连接电脑")
                val id = UUID.randomUUID().toString()
                store.create(id, target.computerId, Instant.now().toString())
                main.post { callback(id, store.temporary(id)) }
            } catch (error: Exception) { mutable.value = mutable.value.copy(capturing = false); publish(userMessage(error)) }
        }
    }
    fun captureFinished(id: String, problem: String? = null) {
        // A disposed activity may still receive a camera callback; leave its journal for recovery.
        if (worker.isShutdown) return
        try { worker.execute {
            try {
                if (problem != null) throw IOException(problem)
                val temporary = store.temporary(id)
                if (!validPhoto(temporary)) throw IOException("照片损坏或过大")
                FileOutputStream(temporary, true).use { it.fd.sync() }
                check(temporary.renameTo(store.file(id))) { "无法保存照片" }
                store.update(id, "pending", hash = fileHash(store.file(id)))
                publish("照片已保存，等待电脑确认")
            } catch (error: Exception) { store.temporary(id).delete(); store.update(id, "capture_failed", error = "拍摄未完成，请重新拍摄"); publish(userMessage(error)) }
            finally { mutable.value = mutable.value.copy(capturing = false) }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { /* Recovered on next launch. */ }
    }
    fun importPhoto(uri: Uri) {
        if (mutable.value.capturing) return
        mutable.value = mutable.value.copy(capturing = true)
        worker.execute {
            var id: String? = null
            try {
                val target = session ?: throw IllegalStateException("请先连接电脑")
                id = UUID.randomUUID().toString()
                store.create(id, target.computerId, Instant.now().toString())
                val temporary = store.temporary(id)
                getApplication<Application>().contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(temporary).use { output ->
                        copyImageWithLimit(input, output, 50L * 1024 * 1024)
                        output.fd.sync()
                    }
                } ?: throw IOException("无法读取所选图片")
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(temporary.path, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > 60_000_000) throw IOException("图片损坏或尺寸过大")
                if (bounds.outMimeType != "image/jpeg") convertToJpeg(temporary)
                if (!validPhoto(temporary)) throw IOException("图片损坏或格式不支持")
                check(temporary.renameTo(store.file(id))) { "无法保存导入图片" }
                store.update(id, "pending", hash = fileHash(store.file(id)))
                publish("图片已导入，等待电脑确认")
            } catch (error: Exception) {
                id?.let { photoId -> store.temporary(photoId).delete(); store.update(photoId, "capture_failed", error = "导入未完成，请重新选择") }
                publish(userMessage(error))
            } finally { mutable.value = mutable.value.copy(capturing = false) }
        }
    }
    fun syncWriting(bitmap: Bitmap) {
        if (mutable.value.capturing) { bitmap.recycle(); return }
        mutable.value = mutable.value.copy(capturing = true)
        worker.execute {
            var id: String? = null
            try {
                val target = session ?: throw IllegalStateException("请先连接电脑")
                id = UUID.randomUUID().toString()
                store.create(id, target.computerId, Instant.now().toString())
                val temporary = store.temporary(id)
                FileOutputStream(temporary).use { output ->
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) throw IOException("无法生成书写图片")
                    output.fd.sync()
                }
                if (!validPhoto(temporary)) throw IOException("书写图片生成失败")
                check(temporary.renameTo(store.file(id))) { "无法保存书写图片" }
                store.update(id, "pending", hash = fileHash(store.file(id)))
                publish("书写图片已保存，等待电脑确认")
            } catch (error: Exception) {
                id?.let { photoId -> store.temporary(photoId).delete(); store.update(photoId, "capture_failed", error = "书写同步未完成，请重试") }
                publish(userMessage(error))
            } finally { bitmap.recycle(); mutable.value = mutable.value.copy(capturing = false) }
        }
    }
    private fun convertToJpeg(file: File) {
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val pixels = info.size.width.toLong() * info.size.height
            if (pixels > 24_000_000) {
                val scale = kotlin.math.sqrt(24_000_000.0 / pixels)
                decoder.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
            }
        }
        try {
            FileOutputStream(file, false).use { output ->
                if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 95, output)) throw IOException("无法转换所选图片")
                output.fd.sync()
            }
        } finally { bitmap.recycle() }
    }
    private fun validPhoto(file: File): Boolean {
        if (!file.exists() || file.length() !in 1..50L * 1024 * 1024) return false
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeFile(file.path, options)
        return options.outMimeType in setOf("image/jpeg", "image/png") && options.outWidth > 0 && options.outHeight > 0 && options.outWidth.toLong() * options.outHeight <= 60_000_000
    }
    private fun recoverPairing() {
        if (session != null) return
        val pending = vault.load("pending") ?: return
        val client = ReceiverApi(pending.address, pending.fingerprint)
        client.status(pending)
        vault.save(pending); vault.clearPending(); session = pending; api = client
        publish("已恢复配对，可以拍照", true)
    }
    private fun tick() {
        if (!foreground || !mutable.value.ready || blocked || mutable.value.pairing) return
        if (session == null) {
            if (System.currentTimeMillis() - lastHeartbeat < 10_000) return
            lastHeartbeat = System.currentTimeMillis()
            runCatching { recoverPairing() }
        }
        val current = session ?: return; val client = api ?: return
        val now = System.currentTimeMillis()
        if (now - lastHeartbeat >= 10_000) {
            lastHeartbeat = now
            try { client.status(current); publish(message = if (mutable.value.online) mutable.value.message else "已连接电脑，拍照后自动上传", online = true) }
            catch (error: Exception) {
                if (error is SSLException || (error is ApiFailure && !error.retryable)) blocked = true
                publish(userMessage(error), false); return
            }
        }
        val photo = store.list().lastOrNull { it.computerId == current.computerId && it.state == "pending" && it.nextAt <= now } ?: return
        store.update(photo.id, "uploading", photo.attempts, hash = photo.hash); publish("正在传送照片…")
        try {
            val file = store.file(photo.id)
            if (!file.exists() || fileHash(file) != photo.hash) throw ApiFailure("LOCAL_FILE_CHANGED", false)
            client.upload(current, photo.id, file, photo.capturedAt, photo.hash)
            store.update(photo.id, "sent", photo.attempts, hash = photo.hash); publish("照片已传到电脑", true)
        } catch (error: Exception) {
            val retryable = error is IOException && error !is SSLException && (error !is ApiFailure || error.retryable)
            val attempt = photo.attempts + 1
            val next = now + retryDelay(attempt)
            store.update(photo.id, if (retryable) "pending" else "failed", attempt, next, userMessage(error), photo.hash)
            if (error is SSLException || (error is ApiFailure && error.code == "UNAUTHORIZED")) blocked = true
            publish(userMessage(error), false)
        }
    }
    override fun onCleared() { foreground = false; worker.execute { store.close() }; worker.shutdown() }
}
fun copyImageWithLimit(input: InputStream, output: OutputStream, limit: Long): Long {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val count = input.read(buffer)
        if (count < 0) return total
        total += count
        if (total > limit) throw IOException("图片超过 50 MB")
        output.write(buffer, 0, count)
    }
}
fun retryDelay(attempt: Int): Long = (2000L * (1L shl attempt.coerceIn(0, 5))).coerceAtMost(60_000)
fun userMessage(error: Exception): String = when {
    error is SSLException -> "证书校验失败，请确认电脑身份并重新扫码"
    error is ApiFailure -> when (error.code) {
        "UNAUTHORIZED" -> "配对已失效，请在电脑解除配对后重新扫码"
        "ALREADY_PAIRED" -> "电脑已有配对，请先在电脑解除配对"
        "PAIRING_EXPIRED" -> "二维码已过期，请在电脑刷新"
        "DISK_FULL" -> "电脑磁盘已满，处理后点击重试"
        "DIRECTORY_UNAVAILABLE" -> "电脑保存目录不可写，处理后点击重试"
        "RECEIVER_BUSY" -> "电脑正在接收，稍后自动重试"
        "LOCAL_FILE_CHANGED" -> "本地照片缺失或已修改，不会上传"
        else -> "传输失败：" + error.code
    }
    error is IOException -> "暂时无法连接电脑，照片保留在本地，恢复连接后自动重试"
    else -> error.message ?: "操作失败，请重试"
}
