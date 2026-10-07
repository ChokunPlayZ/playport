package com.playport.server

import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.WebSocket
import java.time.Duration
import java.util.concurrent.CompletionStage
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class WebHubStatusTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun hub(wireless: Boolean = true) = WebHub(
        ServerConfig(identityDir = temporary.root.toPath(), stateDir = temporary.root.toPath(), wireless = wireless, accessToken = "status-test-token"),
        DisplayState(1280, 720, 60, 100),
    )

    @Test
    fun lateBluetoothEventsCannotReplaceWifiSetupOrAnActiveSession() {
        val hub = hub()
        hub.setConnectionStatus(ConnectionStatus("wifi_connecting", wifiSsid = "Home"), fromBootstrap = true)
        hub.beginAirPlayConnection()
        hub.setConnectionStatus(ConnectionStatus("error", "Bluetooth channel closed"), fromBootstrap = true)
        assertEquals("starting_carplay", hub.connectionStatus.stage)
        hub.setConnectionStatus(hub.connectionStatus.copy(stage = "pairing"))
        hub.setPhoneName("My iPhone")
        assertFalse("Device information alone does not activate CarPlay", hub.stateMessage().sessionActive)
        hub.setSessionState(true, null)
        assertEquals("My iPhone", hub.stateMessage().message)
        hub.setConnectionStatus(ConnectionStatus("wifi_connecting"), fromBootstrap = true)
        assertEquals("connected", hub.connectionStatus.stage)
        hub.setSessionState(false, null)
        assertEquals("reconnecting", hub.connectionStatus.stage)
        assertNull(hub.stateMessage().message)
        hub.setConnectionStatus(ConnectionStatus("bluetooth_connecting"), fromBootstrap = true)
        assertEquals("bluetooth_connecting", hub.connectionStatus.stage)
        assertFalse(hub(wireless = false).connectionStatus.wirelessEnabled)
    }

    @Test
    fun viewersReceiveCurrentProgressOnJoinAndSubsequentUpdatesWithoutWifiPassword() {
        val hub = hub()
        val status = ConnectionStatus("wifi_connecting", wifiSsid = "Home \"Wi-Fi\"")
        hub.setConnectionStatus(status, fromBootstrap = true)
        val http = embeddedServer(Netty, host = "127.0.0.1", port = 0) {
            hub.install(this, temporary.newFolder().toPath())
        }.start(wait = false)
        try {
            val port = runBlocking { http.engine.resolvedConnectors().single().port }
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build().use { client ->
                val messages = LinkedBlockingQueue<String>()
                val listener = object : WebSocket.Listener {
                    private val partial = StringBuilder()
                    override fun onOpen(webSocket: WebSocket) { webSocket.request(1) }
                    override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
                        partial.append(data)
                        if (last) {
                            messages.add(partial.toString())
                            partial.setLength(0)
                        }
                        webSocket.request(1)
                        return null
                    }
                }
                val socket = client.newWebSocketBuilder()
                    .buildAsync(URI("ws://127.0.0.1:$port/ws?token=status-test-token"), listener)
                    .get(5, TimeUnit.SECONDS)
                try {
                    fun next(): ServerMessage = Json.decodeFromString(
                        ServerMessage.serializer(),
                        messages.poll(5, TimeUnit.SECONDS) ?: error("No status message received"),
                    )
                    val hello = next()
                    assertEquals("hello", hello.type)
                    assertEquals(status, hello.connectionStatus)
                    assertFalse(hello.sessionActive)
                    hub.setConnectionStatus(status.copy(stage = "pairing"))
                    assertEquals("pairing", next().connectionStatus!!.stage)
                    hub.setSessionState(true, "iPhone")
                    val active = next()
                    assertEquals("session", active.type)
                    assertTrue(active.sessionActive)
                    assertEquals("connected", active.connectionStatus!!.stage)

                    val response = client.send(
                        HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/status")).build(),
                        HttpResponse.BodyHandlers.ofString(),
                    )
                    val jsonStatus = Json.parseToJsonElement(response.body()).jsonObject
                    assertEquals("connected", Json.decodeFromJsonElement(ConnectionStatus.serializer(), jsonStatus.getValue("connectionStatus")).stage)
                    assertFalse(response.body().contains("passphrase"))
                    assertFalse(response.body().contains("status-test-token"))
                } finally {
                    socket.abort()
                }
            }
        } finally {
            http.stop(0, 1000)
        }
    }
}
