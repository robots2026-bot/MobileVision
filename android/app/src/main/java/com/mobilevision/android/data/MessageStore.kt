package com.mobilevision.android.data

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class TextMessage(val id: String, val computerId: String, val text: String, val source: String, val state: String, val createdAt: String, val copy: Boolean, val nextAt: Long, val attempts: Int, val error: String)
class MessageStore(context: Context) : SQLiteOpenHelper(context, "text-messages.sqlite", null, 1) {
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE messages(id TEXT PRIMARY KEY,computerId TEXT NOT NULL,text TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,createdAt TEXT NOT NULL,copy INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',hidden INTEGER NOT NULL DEFAULT 0)") }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    fun list(): List<TextMessage> = readableDatabase.rawQuery("SELECT * FROM messages WHERE hidden=0 ORDER BY rowid DESC LIMIT 500", null).use { c -> buildList { while (c.moveToNext()) add(TextMessage(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4), c.getString(5), c.getInt(6) != 0, c.getLong(7), c.getInt(8), c.getString(9))) } }
    fun pending(computer: String, now: Long): TextMessage? = readableDatabase.rawQuery("SELECT * FROM messages WHERE computerId=? AND source='phone' AND state='pending' AND nextAt<=? ORDER BY rowid LIMIT 1", arrayOf(computer, now.toString())).use { c -> if (!c.moveToFirst()) null else TextMessage(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4), c.getString(5), c.getInt(6) != 0, c.getLong(7), c.getInt(8), c.getString(9)) }
    fun add(id: String, computer: String, text: String, source: String, time: String, copy: Boolean = false) { writableDatabase.execSQL("INSERT OR IGNORE INTO messages(id,computerId,text,source,state,createdAt,copy) VALUES(?,?,?,?,?,?,?)", arrayOf(id, computer, text, source, if (source == "phone") "pending" else "delivered", time, if (copy) 1 else 0)) }
    fun update(id: String, state: String, nextAt: Long = 0, attempts: Int = 0, error: String = "") { writableDatabase.execSQL("UPDATE messages SET state=?,nextAt=?,attempts=?,error=? WHERE id=?", arrayOf(state, nextAt, attempts, error, id)) }
    fun clean() { writableDatabase.execSQL("UPDATE messages SET hidden=1,text='' WHERE state='delivered'") }
}
