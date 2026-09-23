package com.mobilevision.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

class ImportPhotoTest {
    @Test fun copiesSelectedImageWithoutChangingBytes() {
        val source = ByteArray(150_000) { (it % 251).toByte() }
        val output = ByteArrayOutputStream()
        assertEquals(source.size.toLong(), copyImageWithLimit(ByteArrayInputStream(source), output, source.size.toLong()))
        assertArrayEquals(source, output.toByteArray())
    }

    @Test(expected = IOException::class)
    fun rejectsImageAboveConfiguredLimit() {
        copyImageWithLimit(ByteArrayInputStream(ByteArray(11)), ByteArrayOutputStream(), 10)
    }
}
