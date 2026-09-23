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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
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
    var width by remember { mutableFloatStateOf(7f) }
    var eraser by remember { mutableStateOf(false) }
    var active by remember { mutableStateOf<InkStroke?>(null) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    var confirmClear by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip(selected = !eraser, onClick = { eraser = false }, label = { Text("画笔") })
            FilterChip(selected = eraser, onClick = { eraser = true }, label = { Text("橡皮") })
            TextButton(onClick = document::undo, enabled = document.strokes.isNotEmpty(), modifier = Modifier.testTag("writing-undo")) { Text("撤销") }
            TextButton(onClick = document::redo, enabled = document.undone.isNotEmpty()) { Text("重做") }
            TextButton(onClick = { confirmClear = true }, enabled = document.strokes.isNotEmpty()) { Text("新建") }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf(0xff171717L, 0xffd42a2aL, 0xff245eeaL).forEach { choice ->
                Surface(onClick = { color = choice; eraser = false }, modifier = Modifier.size(34.dp).then(if (color == choice && !eraser) Modifier.border(3.dp, MaterialTheme.colorScheme.primary, CircleShape) else Modifier), shape = CircleShape, color = Color(choice)) {}
            }
            listOf(4f, 7f, 12f).forEach { choice -> FilterChip(selected = width == choice, onClick = { width = choice }, label = { Text(when (choice) { 4f -> "细"; 7f -> "中"; else -> "粗" }) }) }
        }
        Box(Modifier.fillMaxWidth().weight(1f).background(Color.White).border(1.dp, MaterialTheme.colorScheme.outlineVariant).onSizeChanged { canvasSize = it }.pointerInput(color, width, eraser) {
            detectDragGestures(onDragStart = { point -> active = InkStroke(listOf(InkPoint(point.x, point.y)), color, width, eraser) }, onDrag = { change, _ -> change.consume(); active = active?.let { it.copy(points = it.points + InkPoint(change.position.x, change.position.y)) } }, onDragEnd = { active?.let(document::add); active = null }, onDragCancel = { active = null })
        }.testTag("writing-canvas")) {
            Canvas(Modifier.fillMaxSize()) { (document.strokes + listOfNotNull(active)).forEach { stroke -> drawInk(stroke) } }
        }
        Button(onClick = { onSync(renderWriting(document.strokes.toList(), canvasSize)) }, enabled = connected && !busy && document.strokes.isNotEmpty() && canvasSize.width > 0, modifier = Modifier.fillMaxWidth().height(48.dp).testTag("writing-sync")) { Text(if (busy) "正在同步…" else "同步到电脑") }
        Text(if (!connected) "连接电脑后可以同步；草稿已自动保存在手机" else "草稿自动保存 · 点击同步发送当前画面", style = MaterialTheme.typography.bodySmall)
    }
    if (confirmClear) AlertDialog(onDismissRequest = { confirmClear = false }, title = { Text("新建空白页？") }, text = { Text("当前草稿会被清空；已经同步到电脑的图片不受影响。") }, confirmButton = { TextButton(onClick = { document.clear(); confirmClear = false }) { Text("新建") } }, dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("取消") } })
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
