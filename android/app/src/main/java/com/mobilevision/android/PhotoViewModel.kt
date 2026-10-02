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
import com.mobilevision.android.data.*
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

data class PhotoState(val messages: List<TextMessage> = emptyList(), val files: List<TransferFile> = emptyList(), val importing: Boolean = false, val ready: Boolean = false, val session: Session? = null, val photos: List<Photo> = emptyList(), val online: Boolean = false, val pairing: Boolean = false, val capturing: Boolean = false, val message: String = "正在加载…")

class PhotoViewModel(application: Application) : AndroidViewModel(application) {
    private val store = PhotoStore(application)
    private val downloads = DownloadStore(application)
    private val messages = MessageStore(application)
    private val files = FileStore(application)
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
            files.recover(); downloads.recover()
            mutable.value = PhotoState(messages = messages.list(), files = downloads.list() + files.list(), ready = true, session = session, photos = store.list(), message = note)
        }
        worker.scheduleWithFixedDelay({ runCatching { tick() }.onFailure { publish(message = "本地队列错误，请重启后重试") } }, 1, 1, TimeUnit.SECONDS)
    }
    fun foreground(value: Boolean) { foreground = value }
    private fun publish(message: String = mutable.value.message, online: Boolean = mutable.value.online) { mutable.value = mutable.value.copy(messages = messages.list(), files = downloads.list() + files.list(), session = session, photos = store.list(), message = message, online = online) }
    fun pair(text: String) {
        if (mutable.value.pairing) return
        mutable.value = mutable.value.copy(pairing = true, message = "正在安全连接电脑…")
        worker.execute {
            try {
                val pairing = Pairing.parse(text)
                val client = ReceiverApi(pairing.address, pairing.fingerprint)
                val current = session
                val freshPair = {
                    val pending = vault.load("pending")?.takeIf { it.computerId == pairing.computerId && it.fingerprint == pairing.fingerprint }
                    val candidate = pending?.copy(address = pairing.address) ?: Session(pairing.address, pairing.computerId, pairing.name, pairing.fingerprint, java.security.SecureRandom().let { random -> ByteArray(32).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) } })
                    vault.save(candidate, "pending")
                    if (pending != null && runCatching { client.status(candidate) }.isSuccess) candidate else client.pair(pairing, vault.deviceId(), Build.MODEL, candidate.credential)
                }
                val result = if (current != null) {
                    try { client.reconnect(current, pairing) }
                    catch (error: ApiFailure) {
                        if (error.code != "UNAUTHORIZED") throw error
                        freshPair()
                    }
                } else freshPair()
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
    fun syncWriting(bitmap: Bitmap, paste: Boolean = false) {
        if (mutable.value.capturing) { bitmap.recycle(); return }
        mutable.value = mutable.value.copy(capturing = true)
        worker.execute {
            var id: String? = null
            try {
                val target = session ?: throw IllegalStateException("请先连接电脑")
                id = UUID.randomUUID().toString()
                store.create(id, target.computerId, Instant.now().toString(), paste)
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
    fun sendText(text: String, copy: Boolean) { worker.execute {
        try { val current = session ?: throw IllegalStateException("请先连接电脑"); require(text.isNotBlank() && text.toByteArray(Charsets.UTF_8).size <= 64 * 1024) { "每条消息最多 64 KB" }; messages.add(UUID.randomUUID().toString(), current.computerId, text, "phone", Instant.now().toString(), copy); publish("消息等待发送") } catch (error: Exception) { publish(userMessage(error)) }
    } }
    fun retryText(id: String) { worker.execute { messages.update(id, "pending"); blocked = false; lastHeartbeat = 0; publish() } }
    fun cleanMessages() { worker.execute { messages.clean(); publish() } }
    private fun transferText(current: Session, client: ReceiverApi, now: Long) {
        val item = messages.pending(current.computerId, now)
        if (item != null) try {
            val response = client.sendText(current, item.id, item.text, item.copy)
            require(response.getString("id") == item.id && response.getString("state") == "delivered") { "消息确认无效" }
            messages.update(item.id, "delivered"); publish("消息已送达", true)
        } catch (error: Exception) {
            val retryable = error is IOException && error !is SSLException && (error !is ApiFailure || error.retryable)
            messages.update(item.id, if (retryable) "pending" else "failed", now + retryDelay(item.attempts + 1), item.attempts + 1, userMessage(error)); publish(userMessage(error), false)
            if (error is SSLException || (error is ApiFailure && error.code == "UNAUTHORIZED")) blocked = true
            return
        }
        try {
            val incoming = client.messages(current).getJSONArray("messages")
            for (n in 0 until incoming.length()) {
                val m = incoming.getJSONObject(n); val id = m.getString("id"); UUID.fromString(id)
                val text = m.getString("text"); require(text.toByteArray(Charsets.UTF_8).size <= 64 * 1024)
                messages.add(id, current.computerId, text, "desktop", m.getString("createdAt")); client.acknowledgeText(current, id)
            }
            if (incoming.length() > 0) publish("收到电脑消息", true)
        } catch (error: Exception) { if (error is SSLException || (error is ApiFailure && error.code == "UNAUTHORIZED")) blocked = true }
    }
    fun importFiles(uris: List<Uri>) {
        if (uris.isEmpty() || mutable.value.importing) return
        mutable.value = mutable.value.copy(importing = true)
        worker.execute {
            try {
                val target = session ?: throw IllegalStateException("请先连接电脑")
                val resolver = getApplication<Application>().contentResolver
                var imported = 0; var failures = 0; var lastError = ""
                uris.forEach { uri ->
                    val id = UUID.randomUUID().toString()
                    try {
                        var name = "文件"
                        resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
                            if (c.moveToFirst()) {
                                c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it)?.take(240) ?: name }
                                c.getColumnIndex(android.provider.OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { require(c.getLong(it) <= FILE_LIMIT) { "文件超过 2 GB" } }
                            }
                        }
                        val destination = files.file(id)
                        resolver.openInputStream(uri)?.use { input -> FileOutputStream(destination).use { output -> copyFileWithLimit(input, output, FILE_LIMIT); output.fd.sync() } } ?: throw IOException("无法读取文件")
                        files.create(id, target.computerId, name.ifBlank { "文件" }, destination.length(), fileHash(destination)); imported++
                    } catch (error: Exception) { files.file(id).delete(); failures++; lastError = error.message ?: "导入失败" }
                    publish("已加入 $imported 个文件" + if (failures > 0) "，$failures 个失败：$lastError" else "，等待上传")
                }
            } catch (error: Exception) { publish(userMessage(error)) }
            finally { mutable.value = mutable.value.copy(importing = false) }
        }
    }
    fun cancelFile(id: String) { worker.execute { downloads.get(id)?.let { if (it.state !in setOf("received", "canceled")) downloads.update(id, "canceling", it.offset); publish(); return@execute }; files.list().find { it.id == id && it.state !in setOf("sent", "canceled") }?.let { files.update(id, "canceling", it.offset); publish("正在取消文件传输…") } } }
    fun retryFile(id: String) { worker.execute { downloads.get(id)?.let { if (it.state == "failed") downloads.update(id, "receiving", it.offset); blocked = false; lastHeartbeat = 0; publish(); return@execute }; files.list().find { it.id == id && it.state !in setOf("sent", "canceled", "canceling") }?.let { files.update(id, "pending", it.offset); blocked = false; lastHeartbeat = 0; publish("文件等待重试") } } }
    fun cleanFiles() { worker.execute { files.cleanFinished(); downloads.clean(); publish("已清理完成记录，电脑文件和手机原文件不受影响") } }
    fun openReceivedFile(id: String) { worker.execute { val row = downloads.get(id) ?: return@execute; if (row.state != "received" || row.uri.isEmpty()) return@execute; main.post { try { val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(Uri.parse(row.uri), getApplication<Application>().contentResolver.getType(Uri.parse(row.uri)) ?: "application/octet-stream").addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK); getApplication<Application>().startActivity(intent) } catch (_: Exception) { publish("没有能打开此文件的应用，或文件已被移动；请在下载/MobileVision 中查看") } } } }
    private fun receiveFile(current: Session, client: ReceiverApi, now: Long) {
        var row = downloads.active(current.computerId, now)
        try {
            if (row == null) {
                val incoming = client.downloads(current).getJSONArray("files"); if (incoming.length() == 0) return
                val metadata = incoming.getJSONObject(0); val id = metadata.getString("id"); UUID.fromString(id)
                val bytes = metadata.getLong("bytes"); val hash = metadata.getString("sha256"); val name = metadata.getString("name")
                require(bytes in 0..FILE_LIMIT && hash.matches(Regex("[0-9a-f]{64}")) && name.isNotBlank() && name.length <= 240)
                row = downloads.get(id)
                if (row == null) { downloads.create(id, current.computerId, name, bytes, hash); row = downloads.get(id)!! }
                require(row.computerId == current.computerId && row.hash == hash && row.bytes == bytes)
                if (row.state == "received") { client.acknowledgeDownload(current, id, bytes, complete = true, hash = hash); return }
                if (row.state == "failed") return
            }
            val item = row!!
            if (item.state in setOf("canceling", "canceled")) { client.acknowledgeDownload(current, item.id, item.offset, canceled = true); downloads.cancel(item.id); publish("已取消接收"); return }
            val local = downloads.file(item.id); var offset = item.offset
            if (offset < item.bytes) {
                val chunk = client.downloadChunk(current, item.id, offset)
                require(chunk.getString("id") == item.id && chunk.getLong("offset") == offset)
                val bytes = android.util.Base64.decode(chunk.getString("data"), android.util.Base64.DEFAULT)
                require(bytes.size.toLong() == minOf(FILE_CHUNK.toLong(), item.bytes - offset)) { "文件分块响应无效" }
                java.io.RandomAccessFile(local, "rw").use { file -> file.setLength(offset); file.seek(offset); file.write(bytes); file.fd.sync() }
                offset += bytes.size; downloads.update(item.id, "receiving", offset); publish("正在接收：" + item.name, true)
            }
            if (offset == item.bytes) {
                if (!local.exists() && item.bytes == 0L) FileOutputStream(local).use { it.fd.sync() }
                downloads.publish(downloads.get(item.id)!!)
                client.acknowledgeDownload(current, item.id, offset, complete = true, hash = item.hash); publish("文件已保存到下载/MobileVision", true)
            } else client.acknowledgeDownload(current, item.id, offset)
        } catch (error: Exception) {
            val item = row
            if (error is ApiFailure && error.code == "DOWNLOAD_CANCELED" && item != null) { downloads.cancel(item.id); publish("电脑已取消发送"); return }
            if (item != null && downloads.get(item.id)?.state != "received") {
                val retryable = error is IOException && error !is SSLException && (error !is ApiFailure || error.retryable)
                val latest = downloads.get(item.id)!!
                downloads.update(item.id, if (retryable) latest.state else "failed", latest.offset, item.attempts + 1, now + retryDelay(item.attempts + 1), userMessage(error))
            }
            if (error is SSLException || (error is ApiFailure && error.code == "UNAUTHORIZED")) blocked = true
            if (error !is ApiFailure || error.code != "NOT_FOUND") publish(userMessage(error), false)
        }
    }
    private fun transferFile(current: Session, client: ReceiverApi, now: Long) {
        val item = files.list().lastOrNull { it.computerId == current.computerId && it.state in setOf("pending", "uploading", "canceling") && it.nextAt <= now } ?: return
        if (item.state == "canceling") {
            try { client.cancelFile(current, item.id) }
            catch (error: ApiFailure) { if (error.code !in setOf("FILE_NOT_FOUND", "FILE_ALREADY_COMPLETE")) { files.update(item.id, "canceling", item.offset, item.attempts + 1, now + retryDelay(item.attempts + 1), userMessage(error)); publish(); return } }
            catch (error: Exception) { files.update(item.id, "canceling", item.offset, item.attempts + 1, now + retryDelay(item.attempts + 1), userMessage(error)); publish(); return }
            files.update(item.id, "canceled", item.offset); files.file(item.id).delete(); publish("已取消；电脑已接收完成的文件会保留"); return
        }
        try {
            val local = files.file(item.id)
            if (!local.exists() || local.length() != item.bytes) throw ApiFailure("LOCAL_FILE_CHANGED", false)
            // Each request reconciles the server journal, including an acknowledgement lost after a chunk.
            val status = client.prepareFile(current, item.id, item.name, item.bytes, item.hash)
            var offset = status.getLong("offset")
            require(offset in 0..item.bytes && status.getLong("bytes") == item.bytes) { "文件进度响应无效" }
            if (status.getString("state") != "ready" && offset < item.bytes) {
                val buffer = ByteArray(minOf(FILE_CHUNK.toLong(), item.bytes - offset).toInt())
                java.io.RandomAccessFile(local, "r").use { input -> input.seek(offset); input.readFully(buffer) }
                val result = client.fileChunk(current, item.id, offset, buffer)
                require(result.getLong("offset") == offset + buffer.size) { "文件进度响应无效" }
                offset += buffer.size
            }
            if (offset == item.bytes) {
                val result = client.completeFile(current, item.id)
                require(result.getString("state") == "ready" && result.getLong("bytes") == item.bytes && result.getString("receivedAt").isNotBlank()) { "文件确认响应无效" }
                files.update(item.id, "sent", offset); local.delete(); publish("文件已传到电脑", true)
            } else { files.update(item.id, "uploading", offset); publish("正在传送：" + item.name, true) }
        } catch (error: Exception) {
            val retryable = error is IOException && error !is SSLException && (error !is ApiFailure || error.retryable || error.code == "FILE_OFFSET_MISMATCH")
            files.update(item.id, if (retryable) "pending" else "failed", item.offset, item.attempts + 1, now + retryDelay(item.attempts + 1), userMessage(error))
            if (error is SSLException || (error is ApiFailure && error.code == "UNAUTHORIZED")) blocked = true
            publish(userMessage(error), false)
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
        transferText(current, client, now)
        receiveFile(current, client, now)
        transferFile(current, client, now)
        val photo = store.list().lastOrNull { it.computerId == current.computerId && it.state == "pending" && it.nextAt <= now } ?: return
        store.update(photo.id, "uploading", photo.attempts, hash = photo.hash); publish("正在传送照片…")
        try {
            val file = store.file(photo.id)
            if (!file.exists() || fileHash(file) != photo.hash) throw ApiFailure("LOCAL_FILE_CHANGED", false)
            client.upload(current, photo.id, file, photo.capturedAt, photo.hash, photo.paste)
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
    override fun onCleared() { foreground = false; worker.execute { store.close(); files.close() }; worker.shutdown() }
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
        "PHONE_SAVE_FAILED" -> "无法保存到手机下载目录，请检查剩余空间后重试"
        "DISK_FULL" -> "电脑磁盘已满，处理后点击重试"
        "DIRECTORY_UNAVAILABLE" -> "电脑保存目录不可写，处理后点击重试"
        "RECEIVER_BUSY" -> "电脑正在接收，稍后自动重试"
        "LOCAL_FILE_CHANGED" -> "本地文件缺失或已修改，请重新选择"
        "NOT_FOUND" -> "电脑版本不支持文件传输，请更新 Windows 端"
        "CHECKSUM_MISMATCH" -> "文件校验失败，请重试或重新选择原文件"
        else -> "传输失败：" + error.code
    }
    error is IOException -> "暂时无法连接电脑，待传内容保留在本地，恢复连接后自动重试"
    else -> error.message ?: "操作失败，请重试"
}

fun copyFileWithLimit(input: InputStream, output: OutputStream, limit: Long): Long {
    val buffer = ByteArray(64 * 1024); var total = 0L
    while (true) {
        val count = input.read(buffer); if (count < 0) return total
        total += count; if (total > limit) throw IllegalArgumentException("文件超过 2 GB")
        output.write(buffer, 0, count)
    }
}
