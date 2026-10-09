package com.mobilevision.android

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

private val powerLabels = linkedMapOf("screenOff" to "立即息屏", "shutdown" to "关机", "hibernate" to "休眠", "sleep" to "睡眠", "restart" to "重启")

@Composable
fun ComputerPowerPanel(state: PhotoState, refresh: () -> Unit, request: (String, String) -> Unit, cancel: () -> Unit, close: () -> Unit) {
    var selected by remember { mutableStateOf<String?>(null) }
    var confirmedComputer by remember { mutableStateOf("") }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.session?.computerId) { selected = null; while (true) { refresh(); delay(2000) } }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(500) } }
    val job = state.power?.optJSONObject("job")
    val jobState = job?.optString("state") ?: ""
    val displayOff = state.power?.optBoolean("displayOff") == true
    val enabled = state.power?.optBoolean("enabled") == true && state.session != null && state.online && !state.powerBusy && jobState !in setOf("pending", "executing")
    AlertDialog(onDismissRequest = close, title = { Text("电脑电源管理") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(state.session?.name ?: "未连接电脑", style = MaterialTheme.typography.titleMedium)
            Text("立即息屏：点击后关闭电脑显示器，电脑继续运行，按钮会切换为“立即点亮”，再次点击可亮屏，也可移动鼠标或按键亮屏。其余操作确认后等待 5 秒，期间可取消。")
            if (state.power?.optBoolean("enabled") != true) Text("请在电脑连接设置中勾选“允许已配对手机管理电脑电源”。")
            if (state.powerMessage.isNotEmpty()) Text(state.powerMessage, color = MaterialTheme.colorScheme.error)
            if (job != null) {
                val action = job.optString("action")
                val displayAction = action in setOf("screenOff", "screenOn")
                val label = if (action == "screenOn") "立即点亮" else powerLabels[action] ?: "电源操作"
                Text(when (jobState) {
                    "pending" -> if (displayAction) "$label：正在发送请求…" else "$label：${((job.optLong("executeAt") - now + 999) / 1000).coerceAtLeast(0)} 秒后执行"
                    "executing" -> "$label：已开始交给 Windows 处理"
                    "submitted" -> if (displayAction) "$label：请求已发送" else "$label：系统调用已返回，请以电脑实际状态为准"
                    "canceled" -> "$label：已取消"
                    "failed" -> "$label：执行失败，请检查 Windows 电源设置或权限"
                    else -> ""
                }, modifier = Modifier.testTag("power-status"))
                if (jobState == "pending" && !displayAction) Button(onClick = cancel, enabled = !state.powerBusy, modifier = Modifier.testTag("power-cancel")) { Text("取消待执行操作") }
            }
            powerLabels.forEach { (action, label) ->
                OutlinedButton(onClick = { if (action == "screenOff") request(if (displayOff) "screenOn" else "screenOff", state.session?.computerId ?: "") else { confirmedComputer = state.session?.computerId ?: ""; selected = action } }, enabled = enabled, modifier = Modifier.fillMaxWidth().testTag("power-$action")) { Text(if (action == "screenOff" && displayOff) "立即点亮" else label) }
            }
            Text("休眠保存当前会话，睡眠进入低功耗状态；可用性取决于电脑设置。关机和重启前请保存工作，未保存程序可能阻止操作。", style = MaterialTheme.typography.bodySmall)
        }
    }, confirmButton = { TextButton(onClick = close) { Text("关闭") } }, dismissButton = { TextButton(onClick = refresh, enabled = !state.powerBusy) { Text("刷新状态") } })
    selected?.let { action ->
        AlertDialog(onDismissRequest = { selected = null }, title = { Text("确认${powerLabels[action]}？") }, text = { Text("电脑：${state.session?.name}\n请保存工作。确认后 5 秒执行，连接会中断。") }, confirmButton = {
            TextButton(onClick = { selected = null; request(action, confirmedComputer) }, enabled = enabled && confirmedComputer == state.session?.computerId, modifier = Modifier.testTag("power-confirm")) { Text("确认${powerLabels[action]}") }
        }, dismissButton = { TextButton(onClick = { selected = null }) { Text("取消") } })
    }
}
