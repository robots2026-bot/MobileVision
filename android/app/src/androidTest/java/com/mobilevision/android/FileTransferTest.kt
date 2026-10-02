package com.mobilevision.android

import android.content.Context
import android.content.ContextWrapper
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import com.mobilevision.android.data.DownloadStore
import com.mobilevision.android.data.FileStore
import com.mobilevision.android.data.FILE_CHUNK
import com.mobilevision.android.network.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class FileTransferTest {
    @Test fun uploadSyntheticFileAndRecoverQueue() {
        val args = InstrumentationRegistry.getArguments()
        val pairing = Pairing.parse(String(Base64.decode(args.getString("pairing"), Base64.DEFAULT), Charsets.UTF_8))
        val client = ReceiverApi(pairing.address, pairing.fingerprint)
        val session = client.pair(pairing, UUID.randomUUID().toString(), "文件传输隔离测试")
        val bytes = ByteArray(FILE_CHUNK + 137) { (it % 251).toByte() }; val hash = sha256(bytes)
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(target.cacheDir, "file-transfer-test-" + UUID.randomUUID()).apply { mkdirs() }
        val isolated = object : ContextWrapper(target) {
            override fun getFilesDir(): File = root
            override fun getDatabasePath(name: String): File = File(root, name)
            override fun openOrCreateDatabase(name: String, mode: Int, factory: android.database.sqlite.SQLiteDatabase.CursorFactory?): android.database.sqlite.SQLiteDatabase = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), factory)
            override fun openOrCreateDatabase(name: String, mode: Int, factory: android.database.sqlite.SQLiteDatabase.CursorFactory?, errorHandler: android.database.DatabaseErrorHandler?): android.database.sqlite.SQLiteDatabase = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).path, factory, errorHandler)
        }
        var store = FileStore(isolated)
        var downloads = DownloadStore(isolated)
        var receivedUri: android.net.Uri? = null
        var collisionUri: android.net.Uri? = null
        try {
            val id = UUID.randomUUID().toString(); store.file(id).writeBytes(bytes); store.create(id, session.computerId, "synthetic.zip", bytes.size.toLong(), hash)
            assertEquals(0L, client.prepareFile(session, id, "synthetic.zip", bytes.size.toLong(), hash).getLong("offset"))
            val progress = client.fileChunk(session, id, 0, bytes.copyOfRange(0, FILE_CHUNK)).getLong("offset")
            store.update(id, "uploading", progress); store.close(); store = FileStore(isolated); store.recover()
            assertEquals("pending", store.list().single().state); assertEquals(progress, store.list().single().offset)
            val resume = client.prepareFile(session, id, "synthetic.zip", bytes.size.toLong(), hash).getLong("offset"); assertEquals(FILE_CHUNK.toLong(), resume)
            client.fileChunk(session, id, resume, bytes.copyOfRange(resume.toInt(), bytes.size))
            assertEquals("ready", client.completeFile(session, id).getString("state"))
            assertEquals("ready", client.prepareFile(session, id, "synthetic.zip", bytes.size.toLong(), hash).getString("state"))
            store.update(id, "sent", bytes.size.toLong()); store.recover(); assertFalse(store.file(id).exists()); store.cleanFinished(); assertTrue(store.list().isEmpty())
            val canceled = UUID.randomUUID().toString(); client.prepareFile(session, canceled, "cancel.txt", bytes.size.toLong(), hash); assertTrue(client.cancelFile(session, canceled).getBoolean("canceled"))
            var incoming = client.downloads(session).getJSONArray("files")
            for (attempt in 0..30) { if (incoming.length() > 0) break; Thread.sleep(100); incoming = client.downloads(session).getJSONArray("files") }
            assertEquals(1, incoming.length()); val metadata = incoming.getJSONObject(0); val downloadId = metadata.getString("id")
            downloads.create(downloadId, session.computerId, metadata.getString("name"), metadata.getLong("bytes"), metadata.getString("sha256"))
            val part = client.downloadChunk(session, downloadId, 0); val firstBytes = Base64.decode(part.getString("data"), Base64.DEFAULT)
            assertArrayEquals(bytes.copyOfRange(0, FILE_CHUNK), firstBytes)
            java.io.RandomAccessFile(downloads.file(downloadId), "rw").use { it.write(firstBytes); it.fd.sync() }; downloads.update(downloadId, "receiving", firstBytes.size.toLong())
            client.acknowledgeDownload(session, downloadId, firstBytes.size.toLong()); downloads.close(); downloads = DownloadStore(isolated); downloads.recover()
            assertEquals(FILE_CHUNK.toLong(), downloads.get(downloadId)!!.offset)
            val tail = Base64.decode(client.downloadChunk(session, downloadId, FILE_CHUNK.toLong()).getString("data"), Base64.DEFAULT)
            java.io.RandomAccessFile(downloads.file(downloadId), "rw").use { it.seek(FILE_CHUNK.toLong()); it.write(tail); it.fd.sync() }; downloads.update(downloadId, "receiving", bytes.size.toLong())
            receivedUri = downloads.publish(downloads.get(downloadId)!!)
            assertArrayEquals(bytes, target.contentResolver.openInputStream(receivedUri!!)?.use { it.readBytes() })
            assertEquals(receivedUri, downloads.publish(downloads.get(downloadId)!!))
            assertEquals("sent", client.acknowledgeDownload(session, downloadId, bytes.size.toLong(), complete = true, hash = hash).getString("state"))
            assertEquals("sent", client.acknowledgeDownload(session, downloadId, bytes.size.toLong(), complete = true, hash = hash).getString("state"))
            val collisionId = UUID.randomUUID().toString(); downloads.create(collisionId, session.computerId, metadata.getString("name"), bytes.size.toLong(), hash)
            downloads.file(collisionId).writeBytes(bytes); downloads.update(collisionId, "receiving", bytes.size.toLong()); collisionUri = downloads.publish(downloads.get(collisionId)!!)
            assertNotEquals(receivedUri, collisionUri); assertArrayEquals(bytes, target.contentResolver.openInputStream(receivedUri!!)?.use { it.readBytes() }); assertArrayEquals(bytes, target.contentResolver.openInputStream(collisionUri!!)?.use { it.readBytes() })
            downloads.clean(); assertTrue(downloads.list().isEmpty()); assertEquals("received", downloads.get(downloadId)!!.state)
        } finally { receivedUri?.let { target.contentResolver.delete(it, null, null) }; collisionUri?.let { target.contentResolver.delete(it, null, null) }; downloads.close(); store.close(); root.deleteRecursively() }
    }
}
