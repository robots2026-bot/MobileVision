package com.mobilevision.android.camera

import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

fun decodeQr(data: ByteArray, width: Int, height: Int): String? {
    val source = PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false)
    val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)
    // A pure-code fallback also handles tightly cropped, pixel-aligned QR images.
    for (options in listOf(hints, hints + (DecodeHintType.PURE_BARCODE to true))) {
        try { return MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(source)), options).text } catch (_: ReaderException) { }
    }
    return null
}

@Composable
fun CameraPanel(scan: Boolean, front: Boolean, modifier: Modifier, onCaptureReady: (ImageCapture?) -> Unit, onQr: (String) -> Unit, onError: (String) -> Unit, onAspectRatio: (Float) -> Unit = {}) {
    val context = LocalContext.current; val lifecycle = LocalLifecycleOwner.current
    val view = remember { PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE; scaleType = PreviewView.ScaleType.FIT_CENTER } }
    val currentQr by rememberUpdatedState(onQr); val currentError by rememberUpdatedState(onError); val currentReady by rememberUpdatedState(onCaptureReady)
    val currentRatio by rememberUpdatedState(onAspectRatio)
    val orientation = androidx.compose.ui.platform.LocalConfiguration.current.orientation
    DisposableEffect(lifecycle, scan, front, orientation) {
        val future = ProcessCameraProvider.getInstance(context); val executor = Executors.newSingleThreadExecutor()
        var disposed = false; var provider: ProcessCameraProvider? = null; var bindings: Array<UseCase> = emptyArray()
        var delivered = false
        future.addListener({
            if (!disposed) try {
                provider = future.get()
                val rotation = view.display?.rotation ?: android.view.Surface.ROTATION_0
                val preview = Preview.Builder().setTargetRotation(rotation).build().apply {
                    setSurfaceProvider { request ->
                        request.setTransformationInfoListener(ContextCompat.getMainExecutor(context)) { info ->
                            if (!disposed) {
                                val crop = info.cropRect
                                val rotated = info.rotationDegrees % 180 != 0
                                val width = if (rotated) crop.height() else crop.width()
                                val height = if (rotated) crop.width() else crop.height()
                                if (width > 0 && height > 0) currentRatio(width.toFloat() / height)
                            }
                        }
                        view.surfaceProvider.onSurfaceRequested(request)
                    }
                }
                val capture = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).setJpegQuality(95).build()
                val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                if (scan) analysis.setAnalyzer(executor) { frame ->
                    try {
                        if (!delivered) {
                            val plane = frame.planes[0]; val buffer = plane.buffer; val data = ByteArray(frame.width * frame.height)
                            for (y in 0 until frame.height) for (x in 0 until frame.width) data[y * frame.width + x] = buffer.get(y * plane.rowStride + x * plane.pixelStride)
                            val value = decodeQr(data, frame.width, frame.height)
                            if (value != null) { delivered = true; ContextCompat.getMainExecutor(context).execute { if (!disposed) currentQr(value) } }
                        }
                    } catch (_: Exception) { /* Ignore unreadable camera frames; keep scanning. */ }
                    finally { frame.close() }
                }
                bindings = if (scan) arrayOf(preview, analysis) else arrayOf(preview, capture)
                val selector = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                check(provider!!.hasCamera(selector)) { "当前设备没有所选摄像头" }
                provider!!.bindToLifecycle(lifecycle, selector, *bindings)
                currentReady(if (scan) null else capture)
            } catch (error: Exception) { currentReady(null); currentError(error.message ?: "摄像头启动失败") }
        }, ContextCompat.getMainExecutor(context))
        onDispose { disposed = true; currentReady(null); provider?.unbind(*bindings); executor.shutdown() }
    }
    AndroidView(factory = { view }, modifier = modifier)
}
