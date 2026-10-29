package com.mobilevision.android

import android.view.Surface
import com.mobilevision.android.camera.gravityRotation
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceOrientationTest {
    @Test fun mapsGravityToAllFourCaptureDirections() {
        assertEquals(Surface.ROTATION_0, gravityRotation(0))
        assertEquals(Surface.ROTATION_270, gravityRotation(90))
        assertEquals(Surface.ROTATION_180, gravityRotation(180))
        assertEquals(Surface.ROTATION_90, gravityRotation(270))
        assertEquals(Surface.ROTATION_0, gravityRotation(359))
    }

    @Test fun holdsPreviousDirectionNearDiagonalBoundaries() {
        assertEquals(Surface.ROTATION_0, gravityRotation(44, Surface.ROTATION_0))
        assertEquals(Surface.ROTATION_270, gravityRotation(46, Surface.ROTATION_270))
        assertEquals(Surface.ROTATION_270, gravityRotation(90, Surface.ROTATION_0))
        assertEquals(Surface.ROTATION_0, gravityRotation(10, Surface.ROTATION_270))
    }
}
