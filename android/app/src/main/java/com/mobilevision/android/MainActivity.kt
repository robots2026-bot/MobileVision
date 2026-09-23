package com.mobilevision.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mobilevision.android.camera.CameraPanel
import com.mobilevision.android.network.Pairing
import com.mobilevision.android.ui.theme.MobileVisionTheme

class MainActivity : ComponentActivity() {
    private var model: PhotoViewModel? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent { MobileVisionTheme { val vm: PhotoViewModel = viewModel(); model = vm; MobileVisionScreen(vm) } }
    }
    override fun onResume() { super.onResume(); model?.foreground(true) }
    override fun onPause() { model?.foreground(false); super.onPause() }
}

@Composable
fun MobileVisionScreen(vm: PhotoViewModel) {
    val state by vm.state.collectAsState()
    val context = LocalContext.current
    var permission by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var connectionDetails by remember { mutableStateOf(false) }
    var historyPage by remember { mutableIntStateOf(0) }
    var history by remember { mutableStateOf(false) }
    var scan by remember { mutableStateOf(false) }; var front by remember { mutableStateOf(false) }
    var previewRatio by remember { mutableFloatStateOf(3f / 4f) }
    var capture by remember { mutableStateOf<ImageCapture?>(null) }
    var cameraError by remember { mutableStateOf("") }
    var paste by remember { mutableStateOf(false) }; var pairText by remember { mutableStateOf("") }
    var selectedPhoto by remember { mutableStateOf<String?>(null) }
    var pendingPair by remember { mutableStateOf<String?>(null) }; var confirmation by remember { mutableStateOf("") }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permission = it; cameraError = if (it) "" else "需要相机权限才能扫码和拍照" }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) { permission = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED; vm.foreground(true) }
            if (event == androidx.lifecycle.Lifecycle.Event.ON_PAUSE) vm.foreground(false)
        }
        lifecycle.lifecycle.addObserver(observer)
        if (lifecycle.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) vm.foreground(true)
        onDispose { lifecycle.lifecycle.removeObserver(observer); vm.foreground(false) }
    }
    fun proposePair(text: String) {
        try { Pairing.parse(text); pendingPair = text; scan = false; cameraError = "" } catch (_: Exception) { scan = false; cameraError = "这不是有效的 MobileVision 配对二维码，请刷新后重试" }
    }
    val pending = state.photos.count { it.state == "pending" || it.state == "uploading" }
    val sent = state.photos.count { it.state == "sent" }
    val failed = state.photos.count { it.state == "failed" || it.state == "capture_failed" }
    Scaffold(modifier = Modifier.fillMaxSize(), bottomBar = {
        Surface(shadowElevation = 6.dp) { Column {
            NavigationBar {
                NavigationBarItem(selected = !history, onClick = { history = false }, enabled = !state.capturing, icon = { PageIcon(false) }, label = { Text("拍摄") }, modifier = Modifier.testTag("tab-camera"))
                NavigationBarItem(selected = history, onClick = { history = true; scan = false }, enabled = !state.capturing, icon = { PageIcon(true) }, label = { Text("照片记录") }, modifier = Modifier.testTag("tab-history"))
            }
        } }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Surface(onClick = { connectionDetails = true }, shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("connection-details")) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text(state.session?.name ?: "连接电脑", modifier = Modifier.weight(1f), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                    Text(if (state.session == null) "未配对" else if (state.online) "● 已连接" else "○ 离线", modifier = Modifier.testTag("connection"), color = if (state.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelLarge)
                    Text("  设置 ›", style = MaterialTheme.typography.labelLarge)
                }
            }
            if (!history) {
                if ((state.session != null || scan) && permission) {
                    BoxWithConstraints(Modifier.fillMaxWidth().weight(1f, fill = false), contentAlignment = androidx.compose.ui.Alignment.TopCenter) {
                        val width = minOf(maxWidth, maxHeight * previewRatio)
                        CameraPanel(scan, if (scan) false else front, Modifier.width(width).aspectRatio(previewRatio).background(Color.Black).testTag("camera"), { capture = it }, { proposePair(it) }, { cameraError = it }, { previewRatio = it })
                    }
                } else {
                    Column(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.Center, horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
                        Text(if (state.session == null && !scan) "连接电脑后即可拍照并自动传送" else "请允许使用相机")
                        Button(onClick = { if (state.session == null && !scan) connectionDetails = true else permissionLauncher.launch(Manifest.permission.CAMERA) }) { Text(if (state.session == null && !scan) "连接电脑" else "允许使用相机") }
                        if (!permission) TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))) }) { Text("应用设置") }
                    }
                }
                if (scan) Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text("将电脑二维码放入取景框", modifier = Modifier.weight(1f))
                    TextButton(onClick = { scan = false }) { Text("取消扫码") }
                }
                if (cameraError.isNotEmpty()) Text(cameraError, color = MaterialTheme.colorScheme.error, maxLines = 2)
                Text("待传 " + pending + " · 已传 " + sent + if (failed > 0) " · 需处理 " + failed else "", modifier = Modifier.testTag("queue-summary").padding(bottom = 4.dp), style = MaterialTheme.typography.bodySmall)
            if (state.session != null && !scan && !history) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(modifier = Modifier.weight(1f).height(52.dp).testTag("capture"), enabled = permission && capture != null && !state.capturing && !state.pairing, onClick = {
                        val camera = capture
                        if (camera != null) vm.beginCapture { id, file ->
                            camera.targetRotation = (context as? ComponentActivity)?.window?.decorView?.display?.rotation ?: 0
                            try {
                                camera.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageSavedCallback {
                                    override fun onImageSaved(output: ImageCapture.OutputFileResults) { vm.captureFinished(id) }
                                    override fun onError(exception: ImageCaptureException) { vm.captureFinished(id, exception.message ?: "相机拍摄失败") }
                                })
                            } catch (error: Exception) { vm.captureFinished(id, error.message ?: "相机拍摄失败") }
                        }
                    }) { Text(if (state.capturing) "正在保存…" else "拍照") }
                    OutlinedButton(enabled = !state.capturing, onClick = { front = !front; cameraError = "" }) { Text("切换镜头") }
                }
            }

            } else {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("照片记录", style = MaterialTheme.typography.titleLarge)
                    Text("待传 " + pending + " · 已传 " + sent + " · 需处理 " + failed, modifier = Modifier.testTag("queue-summary"))
                    if (state.photos.isEmpty()) Text("还没有照片，点击底部“拍摄”开始。")
                    if (state.photos.any { it.computerId != state.session?.computerId && it.state != "sent" }) Text("其他电脑的待传照片会保留，连接原电脑后再发送。")
            state.photos.drop(historyPage * 20).take(20).forEach { photo ->
                Card(Modifier.fillMaxWidth().clickable { selectedPhoto = photo.id }) {
                    Column(Modifier.padding(12.dp)) {
                        if (photo.state != "capturing" && photo.state != "capture_failed") LocalPhoto(photo.id, Modifier.fillMaxWidth().height(100.dp))
                        Text(localPhotoTime(photo.capturedAt), style = MaterialTheme.typography.bodySmall)
                        val label = when (photo.state) { "sent" -> "已传到电脑"; "pending" -> "等待上传"; "uploading" -> "正在上传"; "capturing" -> "正在拍摄"; else -> "需要处理" }
                        Text(label, modifier = Modifier.testTag("photo-" + photo.id))
                        if (photo.error.isNotEmpty()) Text(photo.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            Row {
                TextButton(onClick = { historyPage-- }, enabled = historyPage > 0) { Text("上一页") }
                Text("第 " + (historyPage + 1) + " 页")
                TextButton(onClick = { historyPage++ }, enabled = (historyPage + 1) * 20 < state.photos.size) { Text("下一页") }
            }
            if (sent > 0) TextButton(onClick = { confirmation = "clean" }) { Text("清理已传照片的手机副本") }

                    Text("照片保存在 App 本地空间；卸载会删除手机副本。下次打开会继续待传任务。", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
    if (connectionDetails) AlertDialog(onDismissRequest = { connectionDetails = false }, title = { Text("连接设置") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(state.session?.name ?: "请打开 Windows 端，显示配对二维码")
            Text(state.message, modifier = Modifier.testTag("status"))
            Button(onClick = { connectionDetails = false; history = false; cameraError = ""; scan = true; if (!permission) permissionLauncher.launch(Manifest.permission.CAMERA) }, enabled = state.ready && !state.pairing && !state.capturing) { Text(if (state.session == null) "扫描二维码" else "扫码更新地址") }
            OutlinedButton(onClick = { connectionDetails = false; paste = true }, enabled = state.ready && !state.pairing && !state.capturing) { Text("粘贴配对信息") }
            if (state.session != null) {
                TextButton(onClick = { vm.retry() }, enabled = !state.pairing) { Text("重新连接 / 重试") }
                TextButton(onClick = { connectionDetails = false; confirmation = "disconnect" }, enabled = !state.capturing && !state.pairing) { Text("断开配对") }
            }
        }
    }, confirmButton = { TextButton(onClick = { connectionDetails = false }) { Text("完成") } })
    selectedPhoto?.let { id -> AlertDialog(onDismissRequest = { selectedPhoto = null }, title = { Text("本地照片") }, text = { LocalPhoto(id, Modifier.fillMaxWidth().height(360.dp)) }, confirmButton = { TextButton(onClick = { selectedPhoto = null }) { Text("关闭") } }) }
    if (paste) AlertDialog(onDismissRequest = { paste = false }, title = { Text("配对信息") }, text = { OutlinedTextField(pairText, { if (it.length <= 4096) pairText = it }, modifier = Modifier.testTag("pair-input"), label = { Text("粘贴完整二维码内容") }, maxLines = 6) }, confirmButton = { TextButton(onClick = { paste = false; proposePair(pairText); pairText = "" }) { Text("继续") } }, dismissButton = { TextButton(onClick = { paste = false }) { Text("取消") } })
    pendingPair?.let { raw ->
        val pairing = Pairing.parse(raw)
        AlertDialog(onDismissRequest = { pendingPair = null }, title = { Text("连接到电脑") }, text = { Text(pairing.name + "\n" + pairing.address + "\n\n确认电脑身份后连接；已有配对将只更新连接地址。") }, confirmButton = { TextButton(onClick = { pendingPair = null; vm.pair(raw) }) { Text("确认连接") } }, dismissButton = { TextButton(onClick = { pendingPair = null }) { Text("取消") } })
    }
    if (confirmation.isNotEmpty()) AlertDialog(onDismissRequest = { confirmation = "" }, title = { Text(if (confirmation == "clean") "清理手机副本？" else "断开配对？") }, text = { Text(if (confirmation == "clean") "只删除电脑已经确认收到的手机副本，待传照片和电脑文件不受影响。" else "本地照片会保留。下次连接需在电脑解除配对后重新扫码。") }, confirmButton = { TextButton(onClick = { if (confirmation == "clean") vm.cleanSent().also { historyPage = 0 } else vm.disconnect(); confirmation = "" }) { Text("确定") } }, dismissButton = { TextButton(onClick = { confirmation = "" }) { Text("取消") } })
}


@Composable
private fun LocalPhoto(id: String, modifier: Modifier) {
    val context = LocalContext.current
    val bitmap by produceState<android.graphics.Bitmap?>(null, id) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val file = java.io.File(context.filesDir, "photos/" + java.util.UUID.fromString(id) + ".jpg")
                val original = android.graphics.BitmapFactory.decodeFile(file.path, android.graphics.BitmapFactory.Options().apply { inSampleSize = 4 }) ?: return@runCatching null
                val exif = android.media.ExifInterface(file.path)
                val rotation = when (exif.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) { 3 -> 180f; 6 -> 90f; 8 -> 270f; else -> 0f }
                if (rotation == 0f) original else android.graphics.Bitmap.createBitmap(original, 0, 0, original.width, original.height, android.graphics.Matrix().apply { postRotate(rotation) }, true).also { if (it != original) original.recycle() }
            }.getOrNull()
        }
    }
    bitmap?.let { Image(it.asImageBitmap(), "本地拍摄照片", modifier) }
}

@Composable
private fun PageIcon(history: Boolean) {
    val color = androidx.compose.material3.LocalContentColor.current
    androidx.compose.foundation.Canvas(Modifier.size(24.dp)) {
        val stroke = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.dp.toPx())
        drawRoundRect(color, topLeft = androidx.compose.ui.geometry.Offset(2.dp.toPx(), 5.dp.toPx()), size = androidx.compose.ui.geometry.Size(20.dp.toPx(), 16.dp.toPx()), cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()), style = stroke)
        if (history) {
            drawCircle(color, radius = 2.dp.toPx(), center = androidx.compose.ui.geometry.Offset(8.dp.toPx(), 10.dp.toPx()))
            drawLine(color, androidx.compose.ui.geometry.Offset(5.dp.toPx(), 18.dp.toPx()), androidx.compose.ui.geometry.Offset(13.dp.toPx(), 12.dp.toPx()), strokeWidth = 2.dp.toPx())
            drawLine(color, androidx.compose.ui.geometry.Offset(13.dp.toPx(), 12.dp.toPx()), androidx.compose.ui.geometry.Offset(20.dp.toPx(), 18.dp.toPx()), strokeWidth = 2.dp.toPx())
        } else {
            drawCircle(color, radius = 4.dp.toPx(), center = androidx.compose.ui.geometry.Offset(12.dp.toPx(), 13.dp.toPx()), style = stroke)
            drawLine(color, androidx.compose.ui.geometry.Offset(8.dp.toPx(), 3.dp.toPx()), androidx.compose.ui.geometry.Offset(16.dp.toPx(), 3.dp.toPx()), strokeWidth = 2.dp.toPx())
        }
    }
}
