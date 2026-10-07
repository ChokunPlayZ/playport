package com.playport.server

import java.nio.file.Files
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermission
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BrowserAccessTokenTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun generatedTokenSurvivesRestartWithFreshDefaults() {
        val defaults = defaults()
        val first = loadServerConfig(emptyArray(), defaults)
        assertTrue(first.accessToken.matches(Regex("[0-9a-f]{32}")))
        assertEquals(first.accessToken, Files.readString(defaults.stateDir.resolve("browser-token")))
        val restarted = loadServerConfig(emptyArray(), defaults.copy(accessToken = ServerConfig.generateToken()))
        assertEquals(first.accessToken, restarted.accessToken)
    }

    @Test
    fun tokenSurvivesSavingDisplayAndCarSettingsAndCliStillWins() {
        val first = loadServerConfig(emptyArray(), defaults())
        val store = ConfigStore(first.stateDir)
        CarPlayServer(first, store).use { server ->
            assertNull(server.applyDisplay(1920, 1080, 60, 100, false))
            assertNull(server.applyBranding(server.branding.settings.copy(manufacturer = "Toyota", rightHandDrive = true)))
        }
        val restarted = loadServerConfig(arrayOf("--width=2560"), first.copy(accessToken = ServerConfig.generateToken()))
        assertEquals(first.accessToken, restarted.accessToken)
        assertEquals(2560, restarted.displayWidth)
        assertEquals(1080, restarted.displayHeight)
        assertEquals("Toyota", restarted.manufacturer)
        assertTrue(restarted.rightHandDrive)
    }

    @Test
    fun explicitTokensReplaceTheSavedTokenAndSurviveRestart() {
        val defaults = defaults()
        loadServerConfig(emptyArray(), defaults)
        for (args in listOf(arrayOf("--token", "first-token"), arrayOf("--token=second-token"))) {
            val replaced = loadServerConfig(args, defaults)
            val expected = args.last().substringAfter('=')
            assertEquals(expected, replaced.accessToken)
            assertEquals(expected, loadServerConfig(emptyArray(), defaults).accessToken)
        }
    }

    @Test
    fun customStateDirectoriesKeepIndependentTokens() {
        val defaults = defaults()
        val stateDir = temporary.newFolder().toPath().resolve("state")
        val first = loadServerConfig(arrayOf("--state-dir", stateDir.toString()), defaults)
        assertFalse(Files.exists(defaults.stateDir.resolve("browser-token")))
        assertEquals(first.accessToken, loadServerConfig(arrayOf("--state-dir=$stateDir"), defaults).accessToken)
        assertNotEquals(first.accessToken, loadServerConfig(emptyArray(), defaults).accessToken)
    }

    @Test
    fun tokenFilesHaveOwnerOnlyPermissionsOnPosixFilesystems() {
        val stateDir = defaults().stateDir
        for (overrideToken in listOf(null, "replacement-token")) {
            BrowserAccessTokenStore.loadOrCreate(stateDir, overrideToken)
            val file = stateDir.resolve("browser-token")
            if (Files.getFileAttributeView(file, PosixFileAttributeView::class.java) != null) {
                assertEquals(
                    setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
                    Files.getPosixFilePermissions(file),
                )
            }
        }
    }

    @Test
    fun blankTokensAndUnreadableStateFailInsteadOfSilentlyChangingTheKey() {
        val defaults = defaults()
        val first = loadServerConfig(emptyArray(), defaults)
        assertThrows(IllegalArgumentException::class.java) {
            loadServerConfig(arrayOf("--token", " "), defaults)
        }
        assertEquals(first.accessToken, loadServerConfig(emptyArray(), defaults).accessToken)
        Files.writeString(defaults.stateDir.resolve("browser-token"), "")
        assertThrows(IllegalArgumentException::class.java) { loadServerConfig(emptyArray(), defaults) }
        assertEquals("recovered-token", loadServerConfig(arrayOf("--token=recovered-token"), defaults).accessToken)
        assertThrows(java.io.IOException::class.java) {
            BrowserAccessTokenStore.loadOrCreate(temporary.newFile("blocked-state-directory").toPath())
        }
    }

    private fun defaults() = ServerConfig(
        identityDir = temporary.newFolder().toPath(),
        stateDir = temporary.newFolder().toPath(),
        bindAddress = "127.0.0.1",
    )
}
