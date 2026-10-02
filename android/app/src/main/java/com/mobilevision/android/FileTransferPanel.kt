package com.mobilevision.android

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import java.util.Locale

private fun fileSize(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> String.format(Locale.US, "%.1f KB", n / 1024.0)
    n < 1024L * 1024 * 1024 -> String.format(Locale.US, "%.1f MB", n / (1024.0 * 1024))
    else -> String.format(Locale.US, "%.2f GB", n / (1024.0 * 1024 * 1024))
}

@Composable
fun FilePageIcon() {
    val color = LocalContentColor.current
    Canvas(Modifier.size(24.dp)) {
        drawRect(color, Offset(size.width * .2f, size.height * .08f), Size(size.width * .6f, size.height * .84f), style = Stroke(2.dp.toPx()))
        for (y in listOf(.38f, .57f, .76f)) drawLine(color, Offset(size.width * .33f, size.height * y), Offset(size.width * .67f, size.height * y), 2.dp.toPx())
    }
}

@Composable
fun FileTransferPanel(state: PhotoState, select: () -> Unit, cancel: (String) -> Unit, retry: (String) -> Unit, clean: () -> Unit, open: (String) -> Unit) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("文件传输", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = clean, enabled = state.files.any { it.state in setOf("sent", "canceled", "received") }) { Text("清理完成记录") }
        }
        Button(onClick = select, enabled = state.ready && state.session != null && !state.importing && !state.pairing, modifier = Modifier.fillMaxWidth().testTag("select-files")) { Text(if (state.importing) "正在准备文件…" else "选择文件 · 自动发送") }
        Text("支持多选，单个文件最大 2 GB。传输时请保持 App 在前台。", style = MaterialTheme.typography.bodySmall)
        Text(state.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("file-status"))
        if (state.files.isEmpty()) Text("还没有传输记录，两端都可以选择文件发送。")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.files, key = { it.id }) { f ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text((if (f.direction == "desktop") "电脑 → 手机 · " else "手机 → 电脑 · ") + f.name, style = MaterialTheme.typography.titleSmall)
                        Text(fileSize(f.bytes) + " · " + when (f.state) { "received" -> "已保存到下载/MobileVision"; "receiving" -> "正在接收"; "sent" -> "已传到电脑"; "canceled" -> "已取消"; "canceling" -> "等待电脑确认取消"; "uploading" -> "正在上传"; "failed" -> "需要处理"; else -> if (f.computerId != state.session?.computerId) "等待连接原电脑" else "等待上传" }, style = MaterialTheme.typography.bodySmall)
                        if (f.state in setOf("pending", "uploading", "receiving")) { LinearProgressIndicator(progress = { if (f.bytes == 0L) 0f else f.offset.toFloat() / f.bytes }, modifier = Modifier.fillMaxWidth()); Text(fileSize(f.offset) + " / " + fileSize(f.bytes), style = MaterialTheme.typography.bodySmall) }
                        if (f.error.isNotEmpty()) Text(f.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                        Row { if (f.state == "received") TextButton(onClick = { open(f.id) }) { Text("打开") }; if (f.state == "failed") TextButton(onClick = { retry(f.id) }) { Text("重试") }; if (f.state in setOf("pending", "uploading", "receiving", "failed")) TextButton(onClick = { cancel(f.id) }) { Text("取消") } }
                    }
                }
            }
        }
    }
}
