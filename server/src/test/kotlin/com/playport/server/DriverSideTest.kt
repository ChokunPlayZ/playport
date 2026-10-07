package com.playport.server

import com.shilapi.xcertplay.airplay.AirPlayInfoPlist
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DriverSideTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun bothSidesReachThePhoneAndSurviveDisplayChangesAndRestart() {
        val config = config()
        val store = ConfigStore(config.stateDir)
        CarPlayServer(config, store).use { server ->
            assertSide(server, false)
            for (right in listOf(true, false)) {
                assertNull(server.applyBranding(server.branding.settings.copy(rightHandDrive = right)))
                assertSide(server, right)
                assertNull(server.applyDisplay(1920, 1080, 60, 100, false))
                assertSide(server, right)
                val saved = store.load()!!
                assertEquals(right, saved.rightHandDrive)
                val defaults = saved.toServerDefaults(config.identityDir, config.stateDir)
                CarPlayServer(defaults).use { restarted -> assertSide(restarted, right) }
            }
        }
    }

    @Test
    fun cliCanOverrideSavedSettingsInEitherDirection() {
        val defaults = config().copy(rightHandDrive = true)
        assertFalse(ServerConfig.fromArgs(arrayOf("--driver-side", "left"), defaults).rightHandDrive)
        assertFalse(ServerConfig.fromArgs(arrayOf("--lhd"), defaults).rightHandDrive)
        val left = defaults.copy(rightHandDrive = false)
        assertTrue(ServerConfig.fromArgs(arrayOf("--driver-side=right"), left).rightHandDrive)
        assertTrue(ServerConfig.fromArgs(arrayOf("--rhd"), left).rightHandDrive)
        assertFalse(ServerConfig.fromArgs(arrayOf("--rhd", "--driver-side=left"), left).rightHandDrive)
        assertTrue(ServerConfig.fromArgs(arrayOf("--lhd", "--driver-side", "right"), defaults).rightHandDrive)
        assertThrows(IllegalArgumentException::class.java) {
            ServerConfig.fromArgs(arrayOf("--driver-side", "middle"), defaults)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ServerConfig.fromArgs(arrayOf("--driver-side"), defaults)
        }
    }

    private fun assertSide(server: CarPlayServer, right: Boolean) {
        assertEquals(right, server.branding.settings.rightHandDrive)
        assertEquals(right, AirPlayInfoPlist.build(server.airPlayConfig)["rightHandDrive"])
    }

    private fun config() = ServerConfig(
        identityDir = temporary.newFolder().toPath(),
        stateDir = temporary.newFolder().toPath(),
        bindAddress = "127.0.0.1",
    )
}
