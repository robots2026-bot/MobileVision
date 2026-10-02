package com.mobilevision.android

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class ImportFileTest {
    @Test fun copiesBinaryWithoutConversion() {
        val bytes = ByteArray(150_003) { (it % 256).toByte() }; val output = ByteArrayOutputStream()
        assertEquals(bytes.size.toLong(), copyFileWithLimit(ByteArrayInputStream(bytes), output, bytes.size.toLong()))
        assertArrayEquals(bytes, output.toByteArray())
    }
    @Test fun acceptsEmptyFile() { assertEquals(0L, copyFileWithLimit(ByteArrayInputStream(byteArrayOf()), ByteArrayOutputStream(), 0)) }
    @Test fun refusesOversizedProviderStream() {
        val output = ByteArrayOutputStream()
        try { copyFileWithLimit(ByteArrayInputStream(ByteArray(100)), output, 99); fail("must enforce byte limit") }
        catch (_: IllegalArgumentException) { assertEquals(0, output.size()) }
    }
}
