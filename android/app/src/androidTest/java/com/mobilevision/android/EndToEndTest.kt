package com.mobilevision.android

import android.Manifest
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.mobilevision.android.camera.decodeQr
import com.mobilevision.android.data.PhotoStore
import com.mobilevision.android.data.SessionVault
import com.mobilevision.android.network.*
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class EndToEndTest {
    @get:Rule(order = 0) val permission: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val config get() = JSONObject(String(Base64.decode(InstrumentationRegistry.getArguments().getString("config"), Base64.NO_WRAP)))
    private val pairing get() = Pairing.parse(config.getJSONObject("pairing").toString())
    private fun photos() = PhotoStore(context).use { it.list() }
    private fun waitUntil(test: () -> Boolean) { compose.waitUntil(90_000) { test() } }
    private fun capture() {
        waitUntil { compose.onAllNodesWithTag("capture").fetchSemanticsNodes().isNotEmpty() }
        waitUntil { runCatching { compose.onNodeWithTag("capture").assertIsEnabled(); true }.getOrDefault(false) }
        compose.onNodeWithTag("capture").performClick()
    }
    private fun control(offline: Boolean) {
        ReceiverApi(pairing.address, pairing.fingerprint).client.newCall(Request.Builder().url(pairing.address + "/test/control").header("X-Test-Key", config.getString("controlKey")).post((if (offline) "offline" else "online").toRequestBody()).build()).execute().use { assertEquals(200, it.code) }
    }
    @Test fun captureAndQueueOffline() {
        val raw = config.getJSONObject("pairing").toString()
        // The same decoder used by CameraX reads a generated QR image, including rotated QR content.
        val matrix = QRCodeWriter().encode(raw, BarcodeFormat.QR_CODE, 600, 600)
        val luminance = ByteArray(600 * 600) { if (matrix[it % 600, it / 600]) 0 else 255.toByte() }
        assertTrue("QR image was not decoded", raw == decodeQr(luminance, 600, 600))
        val rotated = ByteArray(luminance.size) { index -> luminance[(599 - index % 600) * 600 + index / 600] }
        assertTrue("Rotated QR image was not decoded", raw == decodeQr(rotated, 600, 600))
        val badPin = if (pairing.fingerprint.first() == '0') "1" + pairing.fingerprint.drop(1) else "0" + pairing.fingerprint.drop(1)
        try { ReceiverApi(pairing.address, badPin).status(Session(pairing.address, pairing.computerId, pairing.name, badPin, "invalid")); fail("Wrong certificate pin accepted") } catch (_: IOException) { }
        compose.onNodeWithTag("connection-details").performClick()
        compose.onNodeWithText("粘贴配对信息").performClick()
        compose.onNodeWithTag("pair-input").performTextInput(raw)
        compose.onNodeWithText("继续").performClick()
        compose.onNodeWithText("确认连接").performClick()
        capture()
        waitUntil { photos().count { it.state == "sent" } == 1 }
        val first = photos().first()
        PhotoStore(context).use { store ->
            assertTrue(store.file(first.id).exists())
            assertEquals(first.hash, fileHash(store.file(first.id)))
            assertNotNull(BitmapFactory.decodeFile(store.file(first.id).path))
        }
        assertNotNull(SessionVault(context).load())
        // Keep a second real camera image queued while the test proxy refuses requests.
        control(true)
        capture()
        waitUntil { photos().any { it.state == "pending" && it.attempts > 0 } }
        assertEquals(2, photos().size)
        assertEquals(1, photos().count { it.state == "sent" })
        PhotoStore(context).use { store -> assertTrue(store.file(photos().first { it.state == "pending" }.id).exists()) }
        compose.onNodeWithTag("tab-camera").performClick()
        compose.onNodeWithTag("queue-summary").assertTextContains("待传 1", substring = true)
    }
    @Test fun resumeAfterProcessRestart() {
        // The host stops the app process between these two invocations, and restores the receiver.
        waitUntil { photos().size == 2 && photos().all { it.state == "sent" } }
        assertNotNull(SessionVault(context).load())
        compose.onNodeWithTag("tab-writing").assertIsSelected()
        compose.onNodeWithTag("writing-canvas").assertIsDisplayed()
        compose.onNodeWithTag("tab-camera").performClick()
        compose.onNodeWithTag("queue-summary").assertTextContains("已传 2", substring = true)
        val session = SessionVault(context).load()!!
        val reconnect = Pairing.parse(config.getJSONObject("reconnect").toString())
        assertEquals(session.credential, ReceiverApi(reconnect.address, reconnect.fingerprint).reconnect(session, reconnect).credential)
        try { ReceiverApi(reconnect.address, reconnect.fingerprint).reconnect(session, reconnect.copy(computerId = java.util.UUID.randomUUID().toString())); fail("Different computer accepted") } catch (_: IllegalArgumentException) { }
        try { ReceiverApi(reconnect.address, reconnect.fingerprint).reconnect(session, reconnect.copy(fingerprint = "0".repeat(64))); fail("Different fingerprint accepted") } catch (_: IllegalArgumentException) { }
        compose.onNodeWithTag("connection-details").performClick()
        compose.onNodeWithText("粘贴配对信息").performClick()
        compose.onNodeWithTag("pair-input").performTextInput(config.getJSONObject("reconnect").toString())
        compose.onNodeWithText("继续").performClick()
        compose.onNodeWithText("确认连接").performClick()
        waitUntil { SessionVault(context).load()?.address == reconnect.address }
        assertEquals(session.credential, SessionVault(context).load()!!.credential)
        compose.onNodeWithTag("tab-history").performClick()
        compose.onNodeWithTag("tab-history").assertIsSelected()
        compose.onAllNodesWithTag("capture").assertCountEquals(0)
        compose.onNodeWithTag("tab-camera").performClick()
        compose.onNodeWithTag("tab-camera").assertIsSelected()
        compose.onNodeWithTag("capture").assertIsDisplayed()
        compose.onNodeWithTag("import-gallery").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithContentDescription("导入相册").assertIsDisplayed()
        compose.onNodeWithContentDescription("拍照").assertIsDisplayed()
        compose.onNodeWithContentDescription("切换镜头").assertIsDisplayed()
        compose.onNodeWithTag("tab-writing").performClick()
        compose.onNodeWithTag("tab-writing").assertIsSelected()
        compose.onNodeWithTag("writing-canvas").assertIsDisplayed()
        compose.onNodeWithTag("writing-sync").assertIsDisplayed().assertIsNotEnabled()
        listOf("画笔", "橡皮", "颜色", "粗细 4 级", "撤销", "重做", "新建", "同步到电脑").forEach { compose.onNodeWithContentDescription(it).assertIsDisplayed() }
        compose.onNodeWithContentDescription("颜色").performClick()
        compose.onAllNodesWithContentDescription("选择颜色").assertCountEquals(8)
        compose.onAllNodesWithContentDescription("选择颜色")[0].performClick()
        compose.onNodeWithContentDescription("粗细 4 级").performClick()
        compose.onNodeWithTag("writing-width-slider").assertIsDisplayed()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onAllNodesWithTag("capture").assertCountEquals(0)
        compose.onNodeWithTag("tab-camera").performClick()
        val photo = photos().first()
        PhotoStore(context).use { store -> ReceiverApi(session.address, session.fingerprint).upload(session, photo.id, store.file(photo.id), photo.capturedAt, photo.hash) }
        val report = org.json.JSONArray()
        PhotoStore(context).use { store -> photos().forEach { report.put(JSONObject().put("id", it.id).put("hash", fileHash(store.file(it.id))).put("bytes", store.file(it.id).length()).put("state", it.state)) } }
        java.io.File(context.filesDir, "e2e-report.json").writeText(report.toString())
    }
}
