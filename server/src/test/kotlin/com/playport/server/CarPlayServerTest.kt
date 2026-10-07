package com.playport.server

import com.shilapi.xcertplay.airplay.AirPlayInfoPlist
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CarPlayServerTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun wirelessInfoUsesBootstrapBluetoothAddressWithoutChangingAirPlayIdentity() {
        testServer().use { server ->
            val deviceId = server.deviceId
            val bluetoothAddress = "AA:BB:CC:DD:EE:FF"
            server.bluetoothAddress = bluetoothAddress

            val info = AirPlayInfoPlist.build(server.airPlayConfig)
            assertEquals(listOf(bluetoothAddress), info["bluetoothIDs"])
            assertEquals(deviceId, info["deviceID"])
            assertNotEquals(deviceId, bluetoothAddress)

            // Display changes rebuild the declaration and must retain the Bluetooth association.
            server.display.update(1920, 1080, 60, 100, false)
            assertEquals(bluetoothAddress, server.airPlayConfig.btMac)
        }
    }

    private fun testServer(): CarPlayServer = CarPlayServer(
        ServerConfig(
            identityDir = temporary.newFolder("identity").toPath(),
            stateDir = temporary.newFolder("state").toPath(),
            bindAddress = "127.0.0.1",
        ),
    )
}
