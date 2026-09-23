package com.mobilevision.android.data

import android.content.Context
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.mobilevision.android.network.Session
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Photo(val id: String, val computerId: String, val capturedAt: String, val state: String, val attempts: Int, val nextAt: Long, val error: String, val hash: String)

class PhotoStore(context: Context) : SQLiteOpenHelper(context, "photos.sqlite", null, 1) {
    val folder = File(context.filesDir, "photos").apply { mkdirs() }
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE photos (id TEXT PRIMARY KEY, computerId TEXT NOT NULL, capturedAt TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT '')") }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    fun list(): List<Photo> = readableDatabase.rawQuery("SELECT id,computerId,capturedAt,state,attempts,nextAt,error,hash FROM photos ORDER BY capturedAt DESC", null).use { c -> buildList { while (c.moveToNext()) add(Photo(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getInt(4), c.getLong(5), c.getString(6), c.getString(7))) } }
    fun file(id: String) = File(folder, UUID.fromString(id).toString() + ".jpg")
    fun temporary(id: String) = File(folder, UUID.fromString(id).toString() + ".part")
    fun create(id: String, computerId: String, time: String) { writableDatabase.execSQL("INSERT INTO photos(id,computerId,capturedAt,state) VALUES(?,?,?,'capturing')", arrayOf(id, computerId, time)) }
    fun update(id: String, state: String, attempts: Int = 0, nextAt: Long = 0, error: String = "", hash: String? = null) {
        val values = ContentValues().apply { put("state", state); put("attempts", attempts); put("nextAt", nextAt); put("error", error); if (hash != null) put("hash", hash) }
        writableDatabase.update("photos", values, "id=?", arrayOf(id))
    }
    fun retry(computerId: String) { writableDatabase.execSQL("UPDATE photos SET state='pending',nextAt=0,attempts=0,error='' WHERE computerId=? AND state IN ('failed','pending')", arrayOf(computerId)) }
    fun deleteSent(): Int {
        var count = 0
        for (photo in list().filter { it.state == "sent" }) {
            val file = file(photo.id)
            if (!file.exists() || file.delete()) { writableDatabase.delete("photos", "id=? AND state='sent'", arrayOf(photo.id)); count++ }
        }
        return count
    }
}

class SessionVault(context: Context) {
    private val prefs = context.getSharedPreferences("receiver", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("mobilevision.session", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(KeyGenParameterSpec.Builder("mobilevision.session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()) }.generateKey()
    }
    fun save(session: Session, slot: String = "session") {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val bytes = cipher.iv + cipher.doFinal(session.json().toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString(slot, Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()) { "无法保存配对凭据" }
    }
    fun load(slot: String = "session"): Session? {
        val value = prefs.getString(slot, null) ?: return null
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        return Session.parse(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    fun clearPending() { check(prefs.edit().remove("pending").commit()) }
    fun clear() { check(prefs.edit().remove("session").remove("pending").commit()) }
    fun deviceId(): String = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also { check(prefs.edit().putString("deviceId", it).commit()) }
}
