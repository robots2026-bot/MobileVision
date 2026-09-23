package com.mobilevision.android

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun localPhotoTime(value: String, zone: ZoneId = ZoneId.systemDefault()): String = runCatching {
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(zone).format(Instant.parse(value))
}.getOrDefault("时间不可用")
