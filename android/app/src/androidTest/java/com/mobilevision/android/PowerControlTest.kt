package com.mobilevision.android

import android.util.Base64
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.mobilevision.android.network.Pairing
import com.mobilevision.android.network.ReceiverApi
import com.mobilevision.android.network.Session
import com.mobilevision.android.ui.theme.MobileVisionTheme
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class PowerControlTest {
    @get:Rule val compose = createComposeRule()

    @Test fun confirmationAndCancelUi() {
        var requests = 0
        var screenOffRequests = 0
        var screenOnRequests = 0
        var cancels = 0
        val session = Session("https://127.0.0.1:1", "test-computer", "测试电脑", "", "")
        val ui = mutableStateOf(PhotoState(session = session, online = true, power = JSONObject().put("enabled", true)))
        compose.setContent { MobileVisionTheme { ComputerPowerPanel(ui.value, {}, { action, computer ->
            assertEquals(session.computerId, computer)
            when (action) {
                "screenOff" -> { screenOffRequests++; ui.value = ui.value.copy(power = JSONObject().put("enabled", true).put("displayOff", true)) }
                "screenOn" -> { screenOnRequests++; ui.value = ui.value.copy(power = JSONObject().put("enabled", true).put("displayOff", false)) }
                else -> { assertEquals("sleep", action); requests++ }
            }
        }, { cancels++ }, {}) } }
        for (action in listOf("screenOff", "shutdown", "hibernate", "sleep", "restart")) compose.onNodeWithTag("power-$action").performScrollTo().assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithTag("power-screenOff").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, screenOffRequests); assertEquals(0, requests) }
        compose.onNodeWithTag("power-confirm").assertDoesNotExist()
        compose.onNodeWithTag("power-screenOff").assertTextContains("立即点亮").performClick()
        compose.runOnIdle { assertEquals(1, screenOnRequests) }
        compose.onNodeWithTag("power-screenOff").assertTextContains("立即息屏")
        compose.onNodeWithTag("power-confirm").assertDoesNotExist()
        compose.onNodeWithTag("power-sleep").performScrollTo().performClick()
        assertEquals(0, requests)
        compose.onNodeWithText("取消", useUnmergedTree = true).performClick()
        compose.runOnIdle { assertEquals(0, requests) }
        compose.onNodeWithTag("power-sleep").performClick()
        compose.onNodeWithTag("power-confirm").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, requests); assertEquals(0, cancels) }
        compose.runOnIdle { ui.value = ui.value.copy(power = JSONObject().put("enabled", true).put("job", JSONObject().put("action", "sleep").put("state", "pending").put("executeAt", System.currentTimeMillis() + 5000))) }
        compose.onNodeWithTag("power-sleep").assertIsNotEnabled()
        compose.onNodeWithTag("power-cancel").performClick()
        compose.runOnIdle { assertEquals(1, cancels); ui.value = ui.value.copy(power = JSONObject().put("enabled", false)) }
        for (action in listOf("screenOff", "shutdown", "hibernate", "sleep", "restart")) compose.onNodeWithTag("power-$action").assertIsNotEnabled()
    }

    @Test fun wifiPowerRequestsAndCancellation() {
        val raw = InstrumentationRegistry.getArguments().getString("pairing") ?: error("Missing isolated server pairing")
        val pairing = Pairing.parse(String(Base64.decode(raw, Base64.DEFAULT), Charsets.UTF_8))
        val client = ReceiverApi(pairing.address, pairing.fingerprint)
        // This session is used only in memory; it never replaces the user's saved pairing.
        val session = client.pair(pairing, UUID.randomUUID().toString(), "电源隔离测试")
        assertTrue(client.powerStatus(session).getBoolean("enabled"))
        for (action in listOf("shutdown", "hibernate", "sleep", "restart")) {
            val id = UUID.randomUUID().toString()
            val job = client.power(session, id, action).getJSONObject("job")
            assertEquals("pending", job.getString("state"))
            assertEquals(id, client.power(session, id, action).getJSONObject("job").getString("id"))
            assertEquals("canceled", client.cancelPower(session).getJSONObject("job").getString("state"))
            assertEquals("canceled", client.powerStatus(session).getJSONObject("job").getString("state"))
        }
        val screenId = UUID.randomUUID().toString()
        client.power(session, screenId, "screenOff")
        var screenJob = client.powerStatus(session).getJSONObject("job")
        for (attempt in 0..20) { if (screenJob.getString("state") == "submitted") break; Thread.sleep(50); screenJob = client.powerStatus(session).getJSONObject("job") }
        assertEquals("submitted", screenJob.getString("state"))
        assertEquals(screenId, client.power(session, screenId, "screenOff").getJSONObject("job").getString("id"))
        assertTrue(client.powerStatus(session).getBoolean("displayOff"))
        client.power(session, UUID.randomUUID().toString(), "screenOn")
        var onStatus = client.powerStatus(session)
        for (attempt in 0..20) { if (onStatus.getJSONObject("job").getString("state") == "submitted") break; Thread.sleep(50); onStatus = client.powerStatus(session) }
        assertEquals("submitted", onStatus.getJSONObject("job").getString("state"))
        assertFalse(onStatus.getBoolean("displayOff"))
    }
}
