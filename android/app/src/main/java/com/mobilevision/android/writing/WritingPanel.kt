package com.mobilevision.android.writing

import android.graphics.Bitmap
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

data class InkPoint(val x: Float, val y: Float)
data class InkStroke(val points: List<InkPoint>, val color: Long, val width: Float, val eraser: Boolean)

class WritingDocument(private val file: File) {
    val strokes = mutableStateListOf<InkStroke>()
    val undone = mutableStateListOf<InkStroke>()
    private val saver = Executors.newSingleThreadExecutor()
    init { runCatching { load(file.readText()) }.getOrElse { emptyList() }.let(strokes::addAll) }
    fun add(stroke: InkStroke) { if (stroke.points.size > 1) { strokes.add(stroke); undone.clear(); save() } }
    fun undo() { strokes.removeLastOrNull()?.let { undone.add(it); save() } }
    fun redo() { undone.removeLastOrNull()?.let { strokes.add(it); save() } }
    fun clear() { strokes.clear(); undone.clear(); save() }
    private fun save() {
        val text = JSONArray(strokes.map { stroke -> JSONObject().put("color", stroke.color).put("width", stroke.width.toDouble()).put("eraser", stroke.eraser).put("points", JSONArray(stroke.points.map { JSONArray().put(it.x.toDouble()).put(it.y.toDouble()) })) }).toString()
        saver.execute { runCatching { val temporary = File(file.path + ".part"); temporary.writeText(text); if (file.exists()) file.delete(); temporary.renameTo(file) } }
    }
    companion object {
        private fun load(text: String): List<InkStroke> {
            val array = JSONArray(text)
            return buildList { for (index in 0 until array.length()) { val item = array.getJSONObject(index); val points = item.getJSONArray("points"); add(InkStroke(buildList { for (point in 0 until points.length()) { val pair = points.getJSONArray(point); add(InkPoint(pair.getDouble(0).toFloat(), pair.getDouble(1).toFloat())) } }, item.getLong("color"), item.getDouble("width").toFloat(), item.getBoolean("eraser"))) } }
        }
    }
}

@Composable
fun WritingPanel(document: WritingDocument, busy: Boolean, connected: Boolean, onSync: (Bitmap) -> Unit) {
    var color by remember { mutableLongStateOf(0xff171717) }
    var widthLevel by remember { mutableFloatStateOf(4f) }
    var eraser by remember { mutableStateOf(false) }
    var active by remember { mutableStateOf<InkStroke?>(null) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    var confirmClear by remember { mutableStateOf(false) }
    var chooseColor by remember { mutableStateOf(false) }
    var chooseWidth by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    val displayMetrics = LocalContext.current.resources.displayMetrics
    val minimumWidth = with(density) { 1.5.dp.toPx() }
    val maximumWidth = displayMetrics.xdpi / 2.54f
    val width = minimumWidth + (maximumWidth - minimumWidth) * (widthLevel - 1f) / 31f
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            WritingToolButton("画笔", ToolIcon.Pen, selected = !eraser, onClick = { eraser = false })
            WritingToolButton("橡皮", ToolIcon.Eraser, selected = eraser, onClick = { eraser = true })
            WritingToolButton("颜色", ToolIcon.Color, tint = Color(color), onClick = { chooseColor = true })
            WritingToolButton("粗细 ${widthLevel.toInt()} 级", ToolIcon.Width, lineWidth = widthLevel, onClick = { chooseWidth = true })
            WritingToolButton("撤销", ToolIcon.Undo, enabled = document.strokes.isNotEmpty(), modifier = Modifier.testTag("writing-undo"), onClick = document::undo)
            WritingToolButton("重做", ToolIcon.Redo, enabled = document.undone.isNotEmpty(), onClick = document::redo)
            WritingToolButton("新建", ToolIcon.New, enabled = document.strokes.isNotEmpty(), onClick = { confirmClear = true })
            WritingToolButton(if (busy) "正在同步" else "同步到电脑", ToolIcon.Sync, enabled = connected && !busy && document.strokes.isNotEmpty() && canvasSize.width > 0, modifier = Modifier.testTag("writing-sync"), busy = busy, onClick = { onSync(renderWriting(document.strokes.toList(), canvasSize)) })
        }
        Box(Modifier.fillMaxWidth().weight(1f).background(Color.White).border(1.dp, MaterialTheme.colorScheme.outlineVariant).onSizeChanged { canvasSize = it }.pointerInput(color, width, eraser) {
            detectDragGestures(onDragStart = { point -> active = InkStroke(listOf(InkPoint(point.x, point.y)), color, width, eraser) }, onDrag = { change, _ -> change.consume(); active = active?.let { it.copy(points = it.points + InkPoint(change.position.x, change.position.y)) } }, onDragEnd = { active?.let(document::add); active = null }, onDragCancel = { active = null })
        }.testTag("writing-canvas")) {
            Canvas(Modifier.fillMaxSize()) {
                (document.strokes + listOfNotNull(active)).forEach { stroke -> drawInk(stroke) }
                active?.takeIf { it.eraser }?.let { stroke -> stroke.points.lastOrNull()?.let { point ->
                    val center = Offset(point.x, point.y); val radius = stroke.width / 2f
                    drawCircle(Color.Black.copy(alpha = 0.16f), radius, center)
                } }
            }
        }
        Text(if (!connected) "连接电脑后可以同步；草稿已自动保存在手机" else "草稿自动保存 · 工具栏最右侧同步", style = MaterialTheme.typography.bodySmall)
    }
    if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("新建空白页？") }, text = { Text("当前草稿会被清空；已经同步到电脑的图片不受影响。") }, confirmButton = { TextButton(onClick = { document.clear(); confirmClear = false }) { Text("新建") } }, dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("取消") } })
    if (chooseWidth) Dialog(onDismissRequest = { chooseWidth = false }) {
        Surface(shape = MaterialTheme.shapes.large, tonalElevation = 6.dp) {
            Row(Modifier.width(300.dp).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Canvas(Modifier.size(48.dp)) { drawCircle(Color(color), radius = (width / 2f).coerceAtMost(size.minDimension / 2f)) }
                Slider(value = widthLevel, onValueChange = { widthLevel = it }, valueRange = 1f..32f, steps = 30, modifier = Modifier.weight(1f).testTag("writing-width-slider"))
            }
        }
    }
    if (chooseColor) Dialog(onDismissRequest = { chooseColor = false }) {
        val colors = listOf(0xff171717L, 0xffd42a2aL, 0xff245eeaL, 0xff18864bL, 0xffff8a00L, 0xff7a3fc1L, 0xff8b5a2bL, 0xff6b7280L)
        Surface(shape = MaterialTheme.shapes.large, tonalElevation = 6.dp) {
            Column(Modifier.width(210.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("选择画笔颜色", style = MaterialTheme.typography.titleMedium)
                colors.chunked(4).forEach { row -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { row.forEach { choice ->
                    Surface(onClick = { color = choice; eraser = false; chooseColor = false }, modifier = Modifier.size(36.dp).semantics { contentDescription = "选择颜色" }, shape = CircleShape, color = Color.Transparent) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Box(Modifier.size(18.dp).background(Color(choice), CircleShape).then(if (color == choice) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, CircleShape) else Modifier)) }
                    }
                } } }
            }
        }
    }
}

private enum class ToolIcon { Pen, Eraser, Color, Width, Undo, Redo, New, Sync }

@Composable
private fun WritingToolButton(description: String, icon: ToolIcon, modifier: Modifier = Modifier, enabled: Boolean = true, selected: Boolean = false, tint: Color? = null, lineWidth: Float = 4f, busy: Boolean = false, onClick: () -> Unit) {
    val decorated = modifier.size(44.dp).semantics { contentDescription = description }
    val resolvedTint = tint ?: LocalContentColor.current
    val content: @Composable () -> Unit = { if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) else WritingToolIcon(icon, resolvedTint, lineWidth) }
    if (selected) FilledTonalIconButton(onClick = onClick, modifier = decorated, enabled = enabled, content = content) else IconButton(onClick = onClick, modifier = decorated, enabled = enabled, content = content)
}

@Composable
private fun WritingToolIcon(icon: ToolIcon, tint: Color, lineWidth: Float) {
    val foreground = if (icon == ToolIcon.Color) tint else LocalContentColor.current
    val outline = MaterialTheme.colorScheme.outline
    Canvas(Modifier.size(26.dp)) {
        val unit = size.minDimension / 26f
        val stroke = Stroke(2f * unit, cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun point(x: Float, y: Float) = Offset(x * unit, y * unit)
        when (icon) {
            ToolIcon.Pen -> { drawLine(foreground, point(5f, 21f), point(20f, 6f), 3f * unit, StrokeCap.Round); drawLine(foreground, point(4f, 22f), point(9f, 20f), 2f * unit) }
            ToolIcon.Eraser -> { val path = Path().apply { moveTo(5f * unit, 17f * unit); lineTo(15f * unit, 7f * unit); lineTo(22f * unit, 14f * unit); lineTo(12f * unit, 24f * unit); close() }; drawPath(path, foreground, style = stroke); drawLine(foreground, point(9f, 13f), point(16f, 20f), 2f * unit) }
            ToolIcon.Color -> { drawCircle(foreground, 2.7f * unit, center); drawCircle(outline, 3.7f * unit, center, style = Stroke(1.2f * unit)) }
            ToolIcon.Width -> drawLine(foreground, point(3f, 13f), point(23f, 13f), lineWidth.coerceIn(1f, 32f) * 0.28f * unit, StrokeCap.Round)
            ToolIcon.Undo, ToolIcon.Redo -> { val mirror = if (icon == ToolIcon.Undo) 1f else -1f; drawArc(foreground, if (mirror > 0) 205f else -25f, 230f, false, point(5f, 5f), androidx.compose.ui.geometry.Size(16f * unit, 16f * unit), style = stroke); val x = if (mirror > 0) 4f else 22f; drawLine(foreground, point(x, 13f), point(x, 6f), 2f * unit); drawLine(foreground, point(x, 6f), point(x + 6f * mirror, 7f), 2f * unit) }
            ToolIcon.New -> { drawRoundRect(foreground, point(5f, 3f), androidx.compose.ui.geometry.Size(16f * unit, 20f * unit), androidx.compose.ui.geometry.CornerRadius(2f * unit), style = stroke); drawLine(foreground, point(9f, 13f), point(17f, 13f), 2f * unit); drawLine(foreground, point(13f, 9f), point(13f, 17f), 2f * unit) }
            ToolIcon.Sync -> { drawRoundRect(foreground, point(3f, 5f), androidx.compose.ui.geometry.Size(20f * unit, 15f * unit), androidx.compose.ui.geometry.CornerRadius(2f * unit), style = stroke); drawLine(foreground, point(13f, 16f), point(13f, 8f), 2f * unit); drawLine(foreground, point(9f, 12f), point(13f, 8f), 2f * unit); drawLine(foreground, point(17f, 12f), point(13f, 8f), 2f * unit); drawLine(foreground, point(9f, 23f), point(17f, 23f), 2f * unit) }
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawInk(stroke: InkStroke) {
    if (stroke.points.size < 2) return
    val path = Path().apply { moveTo(stroke.points[0].x, stroke.points[0].y); stroke.points.drop(1).forEach { lineTo(it.x, it.y) } }
    drawPath(path, if (stroke.eraser) Color.White else Color(stroke.color), style = Stroke(stroke.width, cap = StrokeCap.Round, join = StrokeJoin.Round))
}

fun renderWriting(strokes: List<InkStroke>, source: IntSize): Bitmap {
    require(source.width > 0 && source.height > 0)
    val width = 1600
    val height = (width.toDouble() * source.height / source.width).toInt().coerceIn(1200, 2800)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bitmap); canvas.drawColor(android.graphics.Color.WHITE)
    val sx = width.toFloat() / source.width; val sy = height.toFloat() / source.height
    for (stroke in strokes) {
        if (stroke.points.size < 2) continue
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = if (stroke.eraser) android.graphics.Color.WHITE else stroke.color.toInt(); style = Paint.Style.STROKE; strokeWidth = stroke.width * (sx + sy) / 2f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
        val path = android.graphics.Path().apply { moveTo(stroke.points[0].x * sx, stroke.points[0].y * sy); stroke.points.drop(1).forEach { lineTo(it.x * sx, it.y * sy) } }
        canvas.drawPath(path, paint)
    }
    return bitmap
}
