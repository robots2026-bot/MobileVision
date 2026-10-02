package com.mobilevision.android

import android.content.ContextWrapper
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import com.mobilevision.android.data.MessageStore
import com.mobilevision.android.network.Pairing
import com.mobilevision.android.network.ReceiverApi
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class TextTransferTest {
    @Test fun bidirectionalTextAndPersistentAcknowledgements() {
        val pairing = Pairing.parse(String(Base64.decode(InstrumentationRegistry.getArguments().getString("pairing"), Base64.DEFAULT), Charsets.UTF_8))
        val client = ReceiverApi(pairing.address, pairing.fingerprint); val session = client.pair(pairing, UUID.randomUUID().toString(), "文本隔离测试")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "text-test-" + UUID.randomUUID()).apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getDatabasePath(name: String): File = File(root, name)
            override fun openOrCreateDatabase(name: String, mode: Int, factory: android.database.sqlite.SQLiteDatabase.CursorFactory?) = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), factory)
            override fun openOrCreateDatabase(name: String, mode: Int, factory: android.database.sqlite.SQLiteDatabase.CursorFactory?, errorHandler: android.database.DatabaseErrorHandler?) = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).path, factory, errorHandler)
        }
        var store = MessageStore(isolated)
        try {
            val text = "手机文本\n  保留缩进\t😀 https://example.com"; val id = UUID.randomUUID().toString()
            store.add(id, session.computerId, text, "phone", java.time.Instant.now().toString(), true); store.close(); store = MessageStore(isolated)
            assertEquals("pending", store.list().single().state)
            assertEquals("delivered", client.sendText(session, id, text, true).getString("state"))
            assertEquals("delivered", client.sendText(session, id, text, true).getString("state")); store.update(id, "delivered")
            var incoming = client.messages(session).getJSONArray("messages")
            for (attempt in 0..30) { if (incoming.length() > 0) break; Thread.sleep(100); incoming = client.messages(session).getJSONArray("messages") }
            assertEquals(1, incoming.length()); val row = incoming.getJSONObject(0); val receivedId = row.getString("id")
            assertEquals("电脑文本\n  双向验证😀", row.getString("text"))
            store.add(receivedId, session.computerId, row.getString("text"), "desktop", row.getString("createdAt")); store.close(); store = MessageStore(isolated)
            assertEquals(2, store.list().size); store.clean(); assertTrue(store.list().isEmpty())
            // Clearing local history before a lost acknowledgement does not cause redisplay.
            store.add(receivedId, session.computerId, row.getString("text"), "desktop", row.getString("createdAt")); assertTrue(store.list().isEmpty())
            client.acknowledgeText(session, receivedId); client.acknowledgeText(session, receivedId)
            assertEquals(0, client.messages(session).getJSONArray("messages").length())
        } finally { store.close(); root.deleteRecursively() }
    }
}
