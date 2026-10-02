package com.mobilevision.android.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.provider.MediaStore
import android.content.ContentValues
import android.os.Environment
import android.webkit.MimeTypeMap
import com.mobilevision.android.network.ApiFailure
import com.mobilevision.android.network.fileHash
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

class DownloadStore(private val context: Context) : SQLiteOpenHelper(context, "received-files.sqlite", null, 1) {
    private val directory = File(context.filesDir, "received-file-parts").apply { mkdirs() }
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE downloads(id TEXT PRIMARY KEY,computerId TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'receiving',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',uri TEXT NOT NULL DEFAULT '',hidden INTEGER NOT NULL DEFAULT 0)") }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    private fun parse(c: android.database.Cursor) = TransferFile(c.getString(0), c.getString(1), c.getString(2), c.getLong(3), c.getString(4), c.getLong(5), c.getString(6), c.getInt(7), c.getLong(8), c.getString(9), "desktop", c.getString(10))
    fun list(): List<TransferFile> = readableDatabase.rawQuery("SELECT * FROM downloads WHERE hidden=0 ORDER BY rowid DESC", null).use { c -> buildList { while (c.moveToNext()) add(parse(c)) } }
    fun get(id: String): TransferFile? = readableDatabase.rawQuery("SELECT * FROM downloads WHERE id=?", arrayOf(id)).use { c -> if (c.moveToFirst()) parse(c) else null }
    fun active(computer: String, now: Long): TransferFile? = readableDatabase.rawQuery("SELECT * FROM downloads WHERE computerId=? AND state IN ('receiving','canceling') AND nextAt<=? ORDER BY rowid LIMIT 1", arrayOf(computer, now.toString())).use { c -> if (c.moveToFirst()) parse(c) else null }
    fun file(id: String): File { require(id.matches(Regex("[0-9a-f-]{36}"))); return File(directory, id + ".part") }
    fun create(id: String, computer: String, name: String, bytes: Long, hash: String) { writableDatabase.execSQL("INSERT INTO downloads(id,computerId,name,bytes,hash) VALUES(?,?,?,?,?)", arrayOf(id, computer, name.replace(Regex("[\\\\/\\u0000-\\u001f]"), "_").take(240).ifBlank { "file" }, bytes, hash)) }
    fun update(id: String, state: String, offset: Long, attempts: Int = 0, nextAt: Long = 0, error: String = "") { writableDatabase.execSQL("UPDATE downloads SET state=?,offset=?,attempts=?,nextAt=?,error=? WHERE id=?", arrayOf(state, offset, attempts, nextAt, error, id)) }
    private fun uri(id: String, value: String) { writableDatabase.execSQL("UPDATE downloads SET uri=? WHERE id=?", arrayOf(value, id)) }
    fun recover() { list().forEach { f -> if (f.state !in setOf("received", "canceled")) { val size = file(f.id).length(); val offset = minOf(f.offset, size); if (size > offset) java.io.RandomAccessFile(file(f.id), "rw").use { it.setLength(offset) }; update(f.id, f.state, offset, f.attempts, error = f.error) } else file(f.id).delete() } }
    private fun validUri(uri: Uri, row: TransferFile): Boolean = runCatching {
        val digest = MessageDigest.getInstance("SHA-256"); var bytes = 0L
        context.contentResolver.openInputStream(uri)?.use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n); bytes += n } } ?: return false
        bytes == row.bytes && digest.digest().joinToString("") { "%02x".format(it) } == row.hash
    }.getOrDefault(false)
    fun publish(row: TransferFile): Uri {
        val resolver = context.contentResolver
        if (row.uri.isNotEmpty()) {
            val previous = Uri.parse(row.uri)
            val visible = runCatching { resolver.query(previous, arrayOf(MediaStore.Downloads.IS_PENDING), null, null, null)?.use { it.moveToFirst() && it.getInt(0) == 0 } == true }.getOrDefault(false)
            if (visible && validUri(previous, row)) { update(row.id, "received", row.bytes); file(row.id).delete(); return previous }
            // Only remove our unpublished entry. A visible file is never removed during recovery.
            if (!visible) runCatching { resolver.delete(previous, null, null) }
            uri(row.id, "")
        }
        val local = file(row.id)
        if (local.length() != row.bytes || fileHash(local) != row.hash) { java.io.RandomAccessFile(local, "rw").use { it.setLength(0) }; update(row.id, "receiving", 0); throw ApiFailure("CHECKSUM_MISMATCH", false) }
        val values = ContentValues().apply { put(MediaStore.Downloads.DISPLAY_NAME, row.name); put(MediaStore.Downloads.MIME_TYPE, MimeTypeMap.getSingleton().getMimeTypeFromExtension(row.name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"); put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MobileVision"); put(MediaStore.Downloads.IS_PENDING, 1) }
        val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw ApiFailure("PHONE_SAVE_FAILED", false)
        uri(row.id, target.toString())
        try {
            resolver.openFileDescriptor(target, "w")?.use { descriptor -> FileOutputStream(descriptor.fileDescriptor).use { output -> local.inputStream().use { it.copyTo(output, 65536) }; output.fd.sync() } } ?: throw ApiFailure("PHONE_SAVE_FAILED", false)
            val ready = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }; check(resolver.update(target, ready, null, null) == 1)
        } catch (_: Exception) { runCatching { resolver.delete(target, null, null) }; uri(row.id, ""); throw ApiFailure("PHONE_SAVE_FAILED", false) }
        update(row.id, "received", row.bytes); local.delete(); return target
    }
    fun cancel(id: String) { val row = get(id) ?: return; if (row.state == "received") return; if (row.uri.isNotEmpty()) { val target = Uri.parse(row.uri); val pending = runCatching { context.contentResolver.query(target, arrayOf(MediaStore.Downloads.IS_PENDING), null, null, null)?.use { it.moveToFirst() && it.getInt(0) == 1 } == true }.getOrDefault(false); if (pending) runCatching { context.contentResolver.delete(target, null, null) } }; file(id).delete(); update(id, "canceled", row.offset) }
    fun clean() { writableDatabase.execSQL("UPDATE downloads SET hidden=1 WHERE state IN ('received','canceled')") }
}
