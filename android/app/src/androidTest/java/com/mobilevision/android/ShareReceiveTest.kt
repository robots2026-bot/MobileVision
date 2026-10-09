package com.mobilevision.android

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.ViewModelProvider
import com.mobilevision.android.data.FileStore
import com.mobilevision.android.data.SessionVault
import com.mobilevision.android.network.sha256
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class ShareReceiveTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun externalSingleAndMultipleSharesOpenFilesAndSurviveRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertNotNull("Pair the phone with the desktop before the WiFi share test", SessionVault(context).load())
        val activity = compose.activity
        val launchIntent = Intent(activity.intent)
        val prefix = "mv-share-" + UUID.randomUUID()
        println("SHARE_FIXTURE_PREFIX=$prefix")
        fun rows() = FileStore(context).use { store -> store.list().filter { it.name.startsWith(prefix) } }
        fun send(batch: String, count: Int) {
            context.startActivity(Intent().setClassName("com.mobilevision.android.test", ShareSenderActivity::class.java.name).putExtra("batch", "$prefix-$batch").putExtra("count", count).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        send("single", 1)
        compose.waitUntil(30_000) { rows().size == 1 }
        compose.onNodeWithTag("tab-files").assertIsSelected()
        send("multi", 2)
        compose.waitUntil(30_000) { rows().size == 3 }
        compose.onNodeWithTag("tab-files").assertIsSelected()
        compose.runOnUiThread {
            val uris = sharedFileUris(activity.intent)
            val vm = ViewModelProvider(activity)[PhotoViewModel::class.java]
            vm.importFiles(listOf(uris[0]), fromShare = true)
            vm.importFiles(listOf(uris[1]), fromShare = true)
        }
        compose.waitUntil(30_000) { rows().size == 5 }
        val expected = listOf("single" to 1, "multi" to 1, "multi" to 2)
        expected.forEach { (batch, index) ->
            val content = "MobileVision share fixture: $prefix-$batch/$index\n中文附件\n".toByteArray(Charsets.UTF_8)
            val matches = rows().filter { it.name == "$prefix-$batch-$index.txt" }
            assertEquals(if (batch == "single") 1 else 2, matches.size)
            matches.forEach { row -> assertEquals(content.size.toLong(), row.bytes); assertEquals(sha256(content), row.hash) }
        }
        // ActivityScenario matches lifecycle events against its launch intent. A real
        // onNewIntent share replaces activity.intent, so restore only test bookkeeping.
        compose.runOnUiThread { activity.intent = launchIntent; activity.recreate() }
        compose.waitUntil(30_000) { activity.isDestroyed }
        compose.onNodeWithTag("tab-files").assertIsSelected()
        compose.waitForIdle(); assertEquals(5, rows().size)
        compose.waitUntil(60_000) { rows().size == 5 && rows().all { it.state == "sent" } }
        // Synthetic files stay in the real queue so the host can verify WiFi delivery.
    }
}
