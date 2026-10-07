package com.shilapi.xcertplay.airplay

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class AirPlayHidTest {
    @Test
    fun releaseKeepsTheClickedCoordinates() {
        val press = AirPlayHid.touchReport(listOf(AirPlayContact(0, 640.0, 360.0, true)))
        val release = AirPlayHid.touchReport(listOf(AirPlayContact(0, 640.0, 360.0, false)))

        assertArrayEquals(byteArrayOf(0, 1, 0x80.toByte(), 2, 0x68, 1, 1, 0, 0, 0, 0, 0), press)
        assertArrayEquals(byteArrayOf(0, 0, 0x80.toByte(), 2, 0x68, 1, 1, 0, 0, 0, 0, 0), release)
    }

    @Test
    fun secondFingerStaysInItsSlotAfterFirstFingerIsReleased() {
        val report = AirPlayHid.touchReport(listOf(AirPlayContact(1, 640.0, 360.0, true)))

        assertArrayEquals(byteArrayOf(0, 0, 0, 0, 0, 0, 1, 1, 0x80.toByte(), 2, 0x68, 1), report)
    }

    @Test
    fun reusingAReleasedSlotDoesNotSwapTheFingers() {
        val first = AirPlayContact(0, 256.0, 512.0, true)
        val second = AirPlayContact(1, 640.0, 360.0, false)

        assertArrayEquals(
            AirPlayHid.touchReport(listOf(first, second)),
            AirPlayHid.touchReport(listOf(second, first)),
        )
    }
}
