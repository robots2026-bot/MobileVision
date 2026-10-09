package com.mobilevision.android

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

class ShareIntentTest {
    private val first = Uri.parse("content://files.example/one")
    private val second = Uri.parse("content://files.example/two")
    @Test fun singleMultipleClipDataAndDeduplication() {
        assertEquals(listOf(first), sharedFileUris(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, first)))
        assertEquals(listOf(first, second), sharedFileUris(Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(first, first, second))))
        val clip = ClipData.newRawUri("files", first).apply { addItem(ClipData.Item(second)) }
        assertEquals(listOf(first, second), sharedFileUris(Intent(Intent.ACTION_SEND_MULTIPLE).apply { clipData = clip }))
        assertEquals(listOf(first), sharedFileUris(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, first).apply { clipData = clip }))
        assertTrue(sharedFileUris(Intent(Intent.ACTION_MAIN)).isEmpty())
    }
    @Test fun rejectsFilePathsTextAndOversizedLists() {
        for (intent in listOf(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///data/user/0/private.txt")), Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "text only"), Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(List(201) { first })))) {
            try { sharedFileUris(intent); fail("Should reject unsupported shared content") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun manifestResolvesBothShareActions() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        for (action in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) {
            val resolved = context.packageManager.queryIntentActivities(Intent(action).setType("application/pdf").setPackage(context.packageName), 0)
            assertTrue(resolved.any { it.activityInfo.name == MainActivity::class.java.name })
        }
    }
}
