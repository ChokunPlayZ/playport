package com.playport.server

import com.shilapi.xcertplay.airplay.AirPlayIcon
import java.awt.BasicStroke
import java.awt.Color
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import javax.imageio.ImageIO
import kotlinx.serialization.Serializable

/** Vehicle layout, identity and return-to-car button advertised to the iPhone. Logo is a PNG data URL. */
@Serializable
data class CarBranding(
    val manufacturer: String,
    val title: String,
    val showBackButton: Boolean = false,
    val logo: String? = null,
    val rightHandDrive: Boolean = false,
)

internal data class PreparedBranding(val settings: CarBranding, val icons: List<AirPlayIcon>)

/** Validates and decodes logos once, and publishes identity and icon together. */
class CarBrandingState(config: ServerConfig) {
    @Volatile private var current = prepare(
        CarBranding(
            config.manufacturer, config.oemLabel ?: config.deviceName, config.oemIconVisible, config.oemLogo,
            rightHandDrive = config.rightHandDrive,
        ),
    )

    val settings: CarBranding get() = current.settings
    internal val snapshot: PreparedBranding get() = current

    internal fun update(prepared: PreparedBranding) {
        current = prepared
    }

    companion object {
        private const val PNG_PREFIX = "data:image/png;base64,"
        const val MAX_LOGO_BYTES = 1_048_576
        private const val ICON_SIZE = 256
        private val defaultLogo: ByteArray by lazy {
            val image = BufferedImage(ICON_SIZE, ICON_SIZE, BufferedImage.TYPE_INT_ARGB)
            val graphics = image.createGraphics()
            try {
                graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                graphics.color = Color(0x1c, 0x1c, 0x1c)
                graphics.fillRoundRect(0, 0, ICON_SIZE, ICON_SIZE, 56, 56)
                graphics.color = Color(0xd4, 0xf6, 0x8a)
                graphics.stroke = BasicStroke(12f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND)
                graphics.drawRoundRect(44, 104, 168, 72, 20, 20)
                graphics.drawLine(60, 104, 80, 64)
                graphics.drawLine(80, 64, 176, 64)
                graphics.drawLine(176, 64, 196, 104)
                graphics.drawLine(64, 176, 64, 192)
                graphics.drawLine(192, 176, 192, 192)
                graphics.fillOval(70, 130, 16, 16)
                graphics.fillOval(170, 130, 16, 16)
            } finally {
                graphics.dispose()
            }
            encodePng(image)
        }

        fun logoFromFile(path: Path): String {
            require(Files.size(path) <= MAX_LOGO_BYTES) { "Logo must be a PNG no larger than 1 MB" }
            return PNG_PREFIX + Base64.getEncoder().encodeToString(Files.readAllBytes(path))
        }

        internal fun prepare(request: CarBranding): PreparedBranding {
            val settings = request.copy(manufacturer = request.manufacturer.trim(), title = request.title.trim())
            validateText(settings.manufacturer, "Manufacturer", 64)
            validateText(settings.title, "Button title", 32)
            val logo = settings.logo?.let(::decodeLogo)
            val icons = if (settings.showBackButton) listOf(logo ?: AirPlayIcon(ICON_SIZE, ICON_SIZE, defaultLogo)) else emptyList()
            return PreparedBranding(settings, icons)
        }

        private fun validateText(value: String, label: String, limit: Int) {
            require(value.isNotEmpty() && value.length <= limit && value.none { it.isISOControl() }) {
                "$label must contain 1–$limit characters without control characters"
            }
        }

        private fun decodeLogo(value: String): AirPlayIcon {
            require(value.startsWith(PNG_PREFIX)) { "Logo must be a PNG image" }
            require(value.length <= PNG_PREFIX.length + ((MAX_LOGO_BYTES + 2) / 3) * 4) {
                "Logo must be no larger than 1 MB"
            }
            val bytes = try {
                Base64.getDecoder().decode(value.substring(PNG_PREFIX.length))
            } catch (_: IllegalArgumentException) {
                throw IllegalArgumentException("Logo contains invalid image data")
            }
            require(bytes.size <= MAX_LOGO_BYTES) { "Logo must be no larger than 1 MB" }
            try {
                ImageIO.createImageInputStream(ByteArrayInputStream(bytes)).use { input ->
                    val readers = ImageIO.getImageReaders(input)
                    require(readers.hasNext()) { "Logo contains invalid image data" }
                    val reader = readers.next()
                    try {
                        require(reader.formatName.equals("png", ignoreCase = true)) { "Logo must be a PNG image" }
                        reader.input = input
                        val width = reader.getWidth(0)
                        val height = reader.getHeight(0)
                        require(width == height && width in 32..1024) {
                            "Logo must be square and between 32 and 1024 pixels"
                        }
                        // Decode fully before accepting, and strip ancillary metadata from the advertised PNG.
                        return AirPlayIcon(width, height, encodePng(reader.read(0)))
                    } finally {
                        reader.dispose()
                    }
                }
            } catch (error: IllegalArgumentException) {
                throw error
            } catch (_: Exception) {
                throw IllegalArgumentException("Logo contains invalid image data")
            }
        }

        private fun encodePng(image: BufferedImage): ByteArray = ByteArrayOutputStream().use {
            check(ImageIO.write(image, "png", it))
            it.toByteArray()
        }
    }
}
