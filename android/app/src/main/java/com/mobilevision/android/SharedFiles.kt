package com.mobilevision.android

import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat

// Do not treat text, nested intents or file:// paths as attachments.
fun sharedFileUris(intent: Intent): List<Uri> {
    if (intent.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return emptyList()
    val streams = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    } else listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
    val candidates = if (streams.isNotEmpty()) streams else intent.clipData?.let { clip ->
        require(clip.itemCount <= 200) { "每次最多分享 200 个文件" }
        (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    }.orEmpty()
    require(candidates.isNotEmpty()) { "分享内容没有文件附件，请在原应用中选择文件后分享" }
    require(candidates.size <= 200) { "每次最多分享 200 个文件" }
    require(candidates.all { it.scheme == "content" && !it.authority.isNullOrBlank() }) { "无法接收此文件地址，请通过系统文件管理器分享" }
    return candidates.distinct()
}
