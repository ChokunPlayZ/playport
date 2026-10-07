package com.playport.server

import com.shilapi.xcertplay.airplay.CarPlayUiScale

/**
 * Live display configuration advertised to the phone in AirPlay /info.
 *
 * Portrait orientation is simply `height > width`. [uiScale] maps to [CarPlayUiScale]: a larger
 * canvas requests proportionally smaller CarPlay controls.
 */
class DisplayState(width: Int, height: Int, fps: Int, uiScale: Int, hevc: Boolean = false) {
    @Volatile var width: Int = width
        private set
    @Volatile var height: Int = height
        private set
    @Volatile var fps: Int = fps
        private set
    @Volatile var uiScale: Int = uiScale
        private set
    @Volatile var hevc: Boolean = hevc
        private set

    fun update(width: Int, height: Int, fps: Int, uiScale: Int, hevc: Boolean) {
        this.width = width
        this.height = height
        this.fps = fps
        this.uiScale = CarPlayUiScale.sanitize(uiScale)
        this.hevc = hevc
    }

    val orientation: String get() = if (height > width) "portrait" else "landscape"

    data class Preset(val label: String, val width: Int, val height: Int, val orientation: String)

    companion object {
        const val MIN_EDGE = 480
        const val MAX_EDGE = 3840

        fun validate(width: Int, height: Int, fps: Int): String? = when {
            width !in MIN_EDGE..MAX_EDGE || height !in MIN_EDGE..MAX_EDGE ->
                "width and height must be between $MIN_EDGE and $MAX_EDGE"
            width % 2 != 0 || height % 2 != 0 -> "width and height must be even"
            fps !in 24..60 -> "fps must be between 24 and 60"
            else -> null
        }

        /** Common car head unit resolutions offered in the web UI. */
        val PRESETS = listOf(
            Preset("800 x 480", 800, 480, "landscape"),
            Preset("1024 x 600", 1024, 600, "landscape"),
            Preset("1280 x 480", 1280, 480, "landscape"),
            Preset("1280 x 720", 1280, 720, "landscape"),
            Preset("1280 x 800", 1280, 800, "landscape"),
            Preset("1440 x 540", 1440, 540, "landscape"),
            Preset("1920 x 720", 1920, 720, "landscape"),
        )
    }
}
