package com.mobilevision.android
import org.junit.Assert.*
import org.junit.Test
class RetryTest {
    @Test fun retriesAreBoundedAndIncreasing() { assertTrue(retryDelay(2) > retryDelay(1)); assertEquals(60_000L, retryDelay(100)); assertTrue(retryDelay(-1) > 0) }
}
