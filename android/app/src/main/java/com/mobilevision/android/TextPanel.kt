package com.mobilevision.android

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import kotlinx.coroutines.launch
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TextPanel(state: PhotoState, send: (String, Boolean) -> Unit, retry: (String) -> Unit, clean: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val preferences = remember { context.getSharedPreferences("text-ui", android.content.Context.MODE_PRIVATE) }
    var draft by rememberSaveable { mutableStateOf(preferences.getString("draft", "") ?: "") }; var notice by remember { mutableStateOf(false) }
    LaunchedEffect(draft) { preferences.edit().putString("draft", draft).apply() }
    val toast = remember { android.widget.Toast.makeText(context, "已复制", android.widget.Toast.LENGTH_SHORT) }
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current; val scroll = rememberLazyListState()
    val rows = state.messages.filter { it.computerId == state.session?.computerId }.reversed()
    val messageTimes = rows.map { localPhotoTime(it.createdAt) }
    val today = java.time.LocalDate.now()
    var previousCount by remember { mutableIntStateOf(0) }
    var last by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(rows.lastOrNull()?.id) {
        val id = rows.lastOrNull()?.id
        if (last == null || (scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1) >= previousCount - 1) { if (rows.isNotEmpty()) scroll.scrollToItem(rows.lastIndex) } else if (id != last) notice = true
        last = id; previousCount = rows.size
    }
    val valid = draft.isNotBlank() && draft.toByteArray(Charsets.UTF_8).size <= 64 * 1024 && state.ready && state.session != null
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("文本消息", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = clean, enabled = rows.any { it.state == "delivered" }) { Text("清理已送达") }
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val bubbleWidth = maxWidth * 0.88f
            LazyColumn(Modifier.fillMaxSize().testTag("text-messages"), state = scroll, contentPadding = PaddingValues(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (rows.isEmpty()) item {
                    Box(Modifier.fillParentMaxSize(), contentAlignment = Alignment.Center) {
                        Text("可发送文字、链接或代码", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                itemsIndexed(rows, key = { _, m -> m.id }) { index, m ->
                    val stamp = messageTimes[index]
                    val day = stamp.substringBefore(' ')
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (index == 0 || day != messageTimes[index - 1].substringBefore(' ')) {
                            val dateLabel = runCatching { val date = java.time.LocalDate.parse(day); when (date) { today -> "今天"; today.minusDays(1) -> "昨天"; else -> date.format(java.time.format.DateTimeFormatter.ofPattern(if (date.year == today.year) "M月d日" else "yyyy年M月d日")) } }.getOrDefault("日期未知")
                            Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) { Text(dateLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        val outgoing = m.source == "phone"
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start) {
                            Card(modifier = Modifier.widthIn(max = bubbleWidth).clip(RoundedCornerShape(18.dp)).combinedClickable(onClick = {}, onLongClickLabel = "复制消息", onLongClick = { clipboard.setText(AnnotatedString(m.text)); toast.show() }), shape = RoundedCornerShape(18.dp), colors = CardDefaults.cardColors(containerColor = if (outgoing) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)) {
                                Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(m.text, style = MaterialTheme.typography.bodyLarge)
                                    Regex("https?://[^\\s<>]+").findAll(m.text).take(5).forEach { link ->
                                        TextButton(onClick = { runCatching { uriHandler.openUri(link.value) } }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp), modifier = Modifier.height(32.dp)) { Text("打开链接", maxLines = 1) }
                                    }
                                    Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        val metaColor = MaterialTheme.colorScheme.onSurfaceVariant
                                        MessageMetaIcon(if (outgoing) "phone" else "computer", if (outgoing) "来自手机" else "来自电脑", metaColor)
                                        Text(stamp.substringAfter(' ', "--:--").take(5), style = MaterialTheme.typography.labelSmall, color = metaColor)
                                        MessageMetaIcon(m.state, when (m.state) { "delivered" -> if (outgoing) "已送达" else "已接收"; "failed" -> "发送失败"; else -> "等待发送" }, if (m.state == "failed") MaterialTheme.colorScheme.error else metaColor)
                                        if (m.state == "failed") IconButton(onClick = { retry(m.id) }, modifier = Modifier.size(32.dp)) { MessageMetaIcon("retry", "重新发送", MaterialTheme.colorScheme.primary) }
                                    }
                                    if (m.error.isNotEmpty()) Text(m.error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                                }
                            }
                        }
                    }
                }
            }
        }
        if (notice) TextButton(onClick = { notice = false; if (rows.isNotEmpty()) scope.launch { scroll.animateScrollToItem(rows.lastIndex) } }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("有新消息 · 查看") }
        OutlinedTextField(value = draft, onValueChange = { draft = it }, modifier = Modifier.fillMaxWidth().testTag("text-draft"), shape = RoundedCornerShape(16.dp), placeholder = { Text("输入文字、链接或代码") }, minLines = 1, maxLines = 5)
        Row(Modifier.fillMaxWidth().padding(bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { send(draft, false); draft = "" }, enabled = valid, modifier = Modifier.weight(1f)) { Text("发送") }
            OutlinedButton(onClick = { send(draft, true); draft = "" }, enabled = valid, modifier = Modifier.weight(2f)) { Text("发送并复制到电脑") }
        }
        if (draft.toByteArray(Charsets.UTF_8).size > 64 * 1024) Text("每条消息最多 64 KB", color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun MessageMetaIcon(kind: String, description: String, color: Color) {
    Canvas(Modifier.size(14.dp).semantics { contentDescription = description }) {
        val unit = size.minDimension / 20f
        fun p(x: Float, y: Float) = Offset(x * unit, y * unit)
        val stroke = Stroke(1.6f * unit, cap = StrokeCap.Round, join = StrokeJoin.Round)
        when (kind) {
            "phone" -> {
                drawRoundRect(color, p(5f, 2f), androidx.compose.ui.geometry.Size(10f * unit, 16f * unit), androidx.compose.ui.geometry.CornerRadius(2f * unit), style = stroke)
                drawLine(color, p(8f, 15f), p(12f, 15f), 1.6f * unit, StrokeCap.Round)
            }
            "computer" -> {
                drawRoundRect(color, p(2f, 3f), androidx.compose.ui.geometry.Size(16f * unit, 11f * unit), androidx.compose.ui.geometry.CornerRadius(1.5f * unit), style = stroke)
                drawLine(color, p(10f, 14f), p(10f, 18f), 1.6f * unit)
                drawLine(color, p(6f, 18f), p(14f, 18f), 1.6f * unit, StrokeCap.Round)
            }
            "delivered" -> { val check = Path().apply { moveTo(4f * unit, 10f * unit); lineTo(8f * unit, 14f * unit); lineTo(16f * unit, 6f * unit) }; drawPath(check, color, style = stroke) }
            "failed" -> {
                drawCircle(color, 8f * unit, center, style = stroke)
                drawLine(color, p(10f, 5f), p(10f, 11f), 1.6f * unit, StrokeCap.Round)
                drawCircle(color, 1f * unit, p(10f, 14f))
            }
            "retry" -> {
                val arrow = Path().apply { moveTo(16f * unit, 13f * unit); cubicTo(20f * unit, 3f * unit, 5f * unit, 1f * unit, 4f * unit, 10f * unit); moveTo(3f * unit, 5f * unit); lineTo(4f * unit, 10f * unit); lineTo(9f * unit, 9f * unit) }
                drawPath(arrow, color, style = stroke)
            }
            else -> {
                drawCircle(color, 8f * unit, center, style = stroke)
                drawLine(color, p(10f, 5f), p(10f, 10f), 1.6f * unit, StrokeCap.Round)
                drawLine(color, p(10f, 10f), p(14f, 12f), 1.6f * unit, StrokeCap.Round)
            }
        }
    }
}
