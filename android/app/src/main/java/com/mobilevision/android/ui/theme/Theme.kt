package com.mobilevision.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(primary = Color(0xFF345EE8), background = Color(0xFFF4F6F9), surface = Color(0xFFF4F6F9))
private val DarkColors = darkColorScheme(primary = Color(0xFFAFC2FF))

@Composable
fun MobileVisionTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, content = content)
}
