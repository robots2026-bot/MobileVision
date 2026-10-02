package com.mobilevision.android

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import kotlinx.coroutines.launch
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp

@Composable
fun TextPanel(state: PhotoState, send: (String, Boolean) -> Unit, retry: (String) -> Unit, clean: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val preferences = remember { context.getSharedPreferences("text-ui", android.content.Context.MODE_PRIVATE) }
    var draft by rememberSaveable { mutableStateOf(preferences.getString("draft", "") ?: "") }; var notice by remember { mutableStateOf(false) }
    LaunchedEffect(draft) { preferences.edit().putString("draft", draft).apply() }
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current; val scroll = rememberLazyListState()
    val rows = state.messages.filter { it.computerId == state.session?.computerId }.reversed()
    var previousCount by remember { mutableIntStateOf(0) }
    var last by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(rows.lastOrNull()?.id) {
        val id = rows.lastOrNull()?.id
        if (last == null || (scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1) >= previousCount - 1) { if (rows.isNotEmpty()) scroll.scrollToItem(rows.lastIndex) } else if (id != last) notice = true
        last = id; previousCount = rows.size
    }
    val valid = draft.isNotBlank() && draft.toByteArray(Charsets.UTF_8).size <= 64 * 1024 && state.ready && state.session != null
    Column(Modifier.fillMaxSize().imePadding(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("文本消息", style = MaterialTheme.typography.titleLarge); TextButton(onClick = clean) { Text("清理已送达") } }
        LazyColumn(Modifier.weight(1f), state = scroll, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(rows, key = { it.id }) { m -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                Text((if (m.source == "phone") "手机" else "电脑") + " · " + localPhotoTime(m.createdAt), style = MaterialTheme.typography.labelSmall)
                SelectionContainer { Text(m.text) }
                Regex("https?://[^\\s<>]+").findAll(m.text).take(5).forEach { link -> TextButton(onClick = { runCatching { uriHandler.openUri(link.value) } }) { Text("打开链接", maxLines = 1) } }
                Row { TextButton(onClick = { clipboard.setText(AnnotatedString(m.text)) }) { Text("复制") }; Text(when (m.state) { "delivered" -> "已送达"; "failed" -> "发送失败"; else -> "等待发送" }, style = MaterialTheme.typography.bodySmall); if (m.state == "failed") TextButton(onClick = { retry(m.id) }) { Text("重试") } }
                if (m.error.isNotEmpty()) Text(m.error, style = MaterialTheme.typography.bodySmall)
            } } }
        }
        if (notice) TextButton(onClick = { notice = false; if (rows.isNotEmpty()) scope.launch { scroll.animateScrollToItem(rows.lastIndex) } }) { Text("有新消息 · 查看") }
        OutlinedTextField(value = draft, onValueChange = { draft = it }, modifier = Modifier.fillMaxWidth(), placeholder = { Text("输入文字、链接或代码") }, minLines = 2, maxLines = 5)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Button(onClick = { send(draft, false); draft = "" }, enabled = valid) { Text("发送") }; OutlinedButton(onClick = { send(draft, true); draft = "" }, enabled = valid) { Text("发送并复制到电脑") } }
        Text(state.message, style = MaterialTheme.typography.bodySmall)
        if (draft.toByteArray(Charsets.UTF_8).size > 64 * 1024) Text("每条消息最多 64 KB", color = MaterialTheme.colorScheme.error)
    }
}
