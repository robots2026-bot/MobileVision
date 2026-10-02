package com.mobilevision.android.data

import android.content.Context
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File

const val FILE_LIMIT = 2L * 1024 * 1024 * 1024
const val FILE_CHUNK = 4 * 1024 * 1024
data class TransferFile(val id: String, val computerId: String, val name: String, val bytes: Long, val hash: String, val offset: Long, val state: String, val attempts: Int, val nextAt: Long, val error: String, val direction: String = "phone", val uri: String = "")

class FileStore(context: Context) : SQLiteOpenHelper(context, "file-transfers.sqlite", null, 1) {
    private val directory = File(context.filesDir, "file-transfers").apply { mkdirs() }
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE files(id TEXT PRIMARY KEY,computerId TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')") }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    fun file(id: String): File { require(id.matches(Regex("[0-9a-f-]{36}"))); return File(directory, id + ".bin") }
    fun list(): List<TransferFile> = readableDatabase.rawQuery("SELECT * FROM files ORDER BY rowid DESC", null).use { c ->
        buildList { while (c.moveToNext()) add(TransferFile(c.getString(0), c.getString(1), c.getString(2), c.getLong(3), c.getString(4), c.getLong(5), c.getString(6), c.getInt(7), c.getLong(8), c.getString(9))) }
    }
    fun create(id: String, computerId: String, name: String, bytes: Long, hash: String) { writableDatabase.execSQL("INSERT INTO files(id,computerId,name,bytes,hash) VALUES(?,?,?,?,?)", arrayOf(id, computerId, name, bytes, hash)) }
    fun update(id: String, state: String, offset: Long, attempts: Int = 0, nextAt: Long = 0, error: String = "") {
        val values = ContentValues().apply { put("state", state); put("offset", offset); put("attempts", attempts); put("nextAt", nextAt); put("error", error) }
        writableDatabase.update("files", values, "id=?", arrayOf(id))
    }
    fun recover() {
        val known = list().associateBy { it.id }
        directory.listFiles()?.filter { it.name.removeSuffix(".bin") !in known }?.forEach { it.delete() }
        known.values.forEach { f ->
            if (f.state == "uploading") update(f.id, "pending", f.offset, error = "上次传输中断，等待续传")
            if (f.state in setOf("sent", "canceled")) file(f.id).delete()
        }
    }
    fun cleanFinished() { list().filter { it.state in setOf("sent", "canceled") }.forEach { f -> if (!file(f.id).exists() || file(f.id).delete()) writableDatabase.delete("files", "id=?", arrayOf(f.id)) } }
}
