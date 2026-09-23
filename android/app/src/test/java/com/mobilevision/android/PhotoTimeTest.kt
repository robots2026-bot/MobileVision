package com.mobilevision.android
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test
class PhotoTimeTest {
    @Test fun convertsUtcAcrossDateBoundary() { assertEquals("2026-09-14 01:30:00", localPhotoTime("2026-09-13T17:30:00Z", ZoneId.of("Asia/Shanghai"))) }
    @Test fun respectsDaylightSaving() { assertEquals("2026-07-01 08:00:00", localPhotoTime("2026-07-01T12:00:00Z", ZoneId.of("America/New_York"))) }
    @Test fun handlesInvalidTime() { assertEquals("时间不可用", localPhotoTime("invalid")) }
}
