package com.mobilevision.android

import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import androidx.test.platform.app.InstrumentationRegistry
import com.mobilevision.android.data.FileStore
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class UnassignedShareTest {
    @Test fun unpairedFilesSurviveRestartAndBindOnlyAfterExplicitAssignment() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(base.cacheDir, "share-store-" + UUID.randomUUID()).apply { mkdirs() }
        val context = object : ContextWrapper(base) {
            override fun getFilesDir() = root
            override fun getDatabasePath(name: String) = File(root, name)
            override fun openOrCreateDatabase(name: String, mode: Int, factory: SQLiteDatabase.CursorFactory?) = SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), factory)
            override fun openOrCreateDatabase(name: String, mode: Int, factory: SQLiteDatabase.CursorFactory?, handler: android.database.DatabaseErrorHandler?) = SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).path, factory, handler)
        }
        val waiting = UUID.randomUUID().toString(); val existing = UUID.randomUUID().toString(); val canceled = UUID.randomUUID().toString()
        try {
            FileStore(context).use { store ->
                for ((id, computer) in listOf(waiting to "", existing to "original-pc", canceled to "")) {
                    store.file(id).writeBytes(byteArrayOf(1, 2, 3)); store.create(id, computer, "$id.bin", 3, "hash")
                }
                store.update(canceled, "canceled", 0)
            }
            FileStore(context).use { store ->
                store.recover(); assertEquals("", store.list().single { it.id == waiting }.computerId)
                assertArrayEquals(byteArrayOf(1, 2, 3), store.file(waiting).readBytes())
                assertEquals(1, store.assignUnassigned("chosen-pc"))
                assertEquals("chosen-pc", store.list().single { it.id == waiting }.computerId)
                assertEquals("original-pc", store.list().single { it.id == existing }.computerId)
                assertEquals("", store.list().single { it.id == canceled }.computerId)
            }
        } finally { root.deleteRecursively() }
    }
}
