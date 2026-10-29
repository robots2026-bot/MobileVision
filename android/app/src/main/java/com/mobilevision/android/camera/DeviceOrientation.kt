package com.mobilevision.android.camera

import android.content.Context
import android.view.OrientationEventListener
import android.view.Surface
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

// The camera activity stays portrait; only the captured photo follows gravity.
fun gravityRotation(degrees: Int, previous: Int = Surface.ROTATION_0): Int {
    // Canonical mapping from CameraXBasic: the listener reports degrees counter-clockwise,
    // while targetRotation compensates in the opposite direction for the 90°/270° tilts.
    val candidate = when (degrees) {
        in 45 until 135 -> Surface.ROTATION_270
        in 135 until 225 -> Surface.ROTATION_180
        in 225 until 315 -> Surface.ROTATION_90
        else -> Surface.ROTATION_0
    }
    val boundary = (degrees + 45) % 90
    return if (boundary < 5 || boundary >= 85) previous else candidate
}

class DeviceOrientation(context: Context, private val fallback: () -> Int, private val onRotation: (Int) -> Unit) : DefaultLifecycleObserver {
    private var rotation = fallback()
    private val listener = object : OrientationEventListener(context) {
        override fun onOrientationChanged(degrees: Int) {
            if (degrees == ORIENTATION_UNKNOWN) return
            rotation = gravityRotation(degrees, rotation)
            onRotation(rotation)
        }
    }
    override fun onResume(owner: LifecycleOwner) { if (listener.canDetectOrientation()) listener.enable() else onRotation(fallback()) }
    override fun onPause(owner: LifecycleOwner) { listener.disable() }
}
