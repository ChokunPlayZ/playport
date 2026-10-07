package com.playport.server

import com.shilapi.xcertplay.airplay.AirPlayInfoPlist
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.Base64
import javax.imageio.ImageIO
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CarBrandingTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun customLogoAndIndependentTitleReachThePhoneAndSurviveDisplayChangesAndRestart() {
        val config = config()
        val store = ConfigStore(config.stateDir)
        val settings = CarBranding("  Toyota  ", "  My car  ", true, logo())
        CarPlayServer(config, store).use { server ->
            assertNull(server.applyBranding(settings))
            assertBranding(server)
            assertNull(server.applyDisplay(1920, 1080, 60, 100, false))
            assertBranding(server)
        }
        val saved = store.load()!!
        assertEquals("Toyota", saved.manufacturer)
        assertEquals("My car", saved.oemLabel)
        assertEquals(settings.logo, saved.oemLogo)
        assertTrue(saved.oemIconVisible)
        assertEquals(1920, saved.display.width)
        CarPlayServer(saved.toServerDefaults(config.identityDir, config.stateDir)).use(::assertBranding)
    }

    @Test
    fun visibilityAndDefaultIconCanBeChangedWithoutLosingTheCustomLogo() {
        CarPlayServer(config()).use { server ->
            assertFalse(AirPlayInfoPlist.build(server.airPlayConfig).containsKey("oemIcons"))
            val settings = CarBranding("BMW", "BMW", true)
            assertNull(server.applyBranding(settings))
            val icon = server.airPlayConfig.icons.single()
            assertEquals(256, icon.widthPixels)
            assertNotNull(ImageIO.read(ByteArrayInputStream(icon.data)))
            val custom = settings.copy(logo = logo())
            assertNull(server.applyBranding(custom))
            assertNull(server.applyBranding(custom.copy(showBackButton = false)))
            assertEquals(custom.logo, server.branding.settings.logo)
            assertFalse(AirPlayInfoPlist.build(server.airPlayConfig).containsKey("oemIcons"))
            assertNull(server.applyBranding(custom))
            assertEquals(64, server.airPlayConfig.icons.single().widthPixels)
        }
    }

    @Test
    fun invalidTextAndImagesAreRejectedWithoutChangingOrSavingSettings() {
        val config = config()
        val store = ConfigStore(config.stateDir)
        CarPlayServer(config, store).use { server ->
            val original = server.branding.settings
            val valid = CarBranding("Toyota", "Car", true)
            val invalid = listOf(
                valid.copy(manufacturer = "  "),
                valid.copy(manufacturer = "a".repeat(65)),
                valid.copy(manufacturer = "Toyota\u0000"),
                valid.copy(title = ""),
                valid.copy(title = "a".repeat(33)),
                valid.copy(logo = "https://example.com/logo.png"),
                valid.copy(logo = "data:image/png;base64,not-base64!"),
                valid.copy(logo = "data:image/png;base64,AQIDBA=="),
                valid.copy(logo = logo(64, 32)),
                valid.copy(logo = logo(16, 16)),
                valid.copy(logo = logo(2048, 2048)),
                valid.copy(logo = "data:image/png;base64," + "A".repeat(1_400_000)),
            )
            for (request in invalid) {
                assertNotNull(server.applyBranding(request))
                assertEquals(original, server.branding.settings)
                assertNull(store.load())
            }
        }
    }

    @Test
    fun failedSaveLeavesRunningBrandingUntouched() {
        val store = ConfigStore(temporary.newFile("blocked-state-directory").toPath())
        CarPlayServer(config(), store).use { server ->
            val original = server.branding.settings
            assertNotNull(server.applyBranding(CarBranding("Toyota", "Car", true, rightHandDrive = true)))
            assertEquals(original, server.branding.settings)
            assertFalse(server.airPlayConfig.rightHandDrive)
        }
    }

    @Test
    fun olderSavedConfigsRetainTheirManufacturerAndDeviceNameDefaults() {
        val saved = Json.decodeFromString(PersistentConfig.serializer(), """{"manufacturer":"Honda","deviceName":"Garage"}""")
        val config = config()
        val defaults = saved.toServerDefaults(config.identityDir, config.stateDir)
        val settings = CarBrandingState(defaults).settings
        assertEquals("Honda", settings.manufacturer)
        assertEquals("Garage", settings.title)
        assertFalse(settings.showBackButton)
        assertNull(settings.logo)
        assertFalse(settings.rightHandDrive)
    }

    @Test
    fun cliOverridesSavedTitleLogoAndVisibility() {
        val file = temporary.newFile("logo.png").toPath()
        Files.write(file, Base64.getDecoder().decode(logo().substringAfter(',')))
        val defaults = config().copy(oemLabel = "Saved", oemIconVisible = false)
        val parsed = ServerConfig.fromArgs(arrayOf("--manufacturer", "Porsche", "--oem-label=911", "--oem-logo", file.toString()), defaults)
        val settings = CarBrandingState(parsed).settings
        assertEquals("Porsche", settings.manufacturer)
        assertEquals("911", settings.title)
        assertTrue(settings.showBackButton)
        assertNotNull(settings.logo)
        assertFalse(ServerConfig.fromArgs(arrayOf("--no-oem-icon"), parsed).oemIconVisible)
        assertTrue(ServerConfig.fromArgs(arrayOf("--oem-icon"), defaults).oemIconVisible)
    }

    private fun assertBranding(server: CarPlayServer) {
        val info = AirPlayInfoPlist.build(server.airPlayConfig)
        assertEquals("PlayPort", info["name"])
        assertEquals("Toyota", info["manufacturer"])
        assertEquals("My car", info["oemIconLabel"])
        assertEquals(true, info["oemIconVisible"])
        val icon = (info["oemIcons"] as List<*>).single() as Map<*, *>
        assertEquals(64, icon["widthPixels"])
        val image = ImageIO.read(ByteArrayInputStream(icon["imageData"] as ByteArray))
        assertEquals(0xff123456.toInt(), image.getRGB(0, 0))
    }

    private fun logo(width: Int = 64, height: Int = 64): String {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB)
        image.setRGB(0, 0, 0xff123456.toInt())
        val bytes = ByteArrayOutputStream().use { ImageIO.write(image, "png", it); it.toByteArray() }
        return "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes)
    }

    private fun config() = ServerConfig(
        identityDir = temporary.newFolder().toPath(),
        stateDir = temporary.newFolder().toPath(),
        bindAddress = "127.0.0.1",
    )
}
