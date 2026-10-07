package com.playport.server

import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class WebHubCarTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun carApiAuthenticatesReadsAndWritesValidatesAndReturnsCurrentSettings() {
        val config = ServerConfig(
            identityDir = temporary.newFolder().toPath(),
            stateDir = temporary.newFolder().toPath(),
            bindAddress = "127.0.0.1",
            accessToken = "car-test-token",
        )
        CarPlayServer(config, ConfigStore(config.stateDir)).use { server ->
            val http = embeddedServer(Netty, host = "127.0.0.1", port = 0) {
                server.hub.install(this, temporary.newFolder().toPath())
            }.start(wait = false)
            try {
                val port = runBlocking { http.engine.resolvedConnectors().single().port }
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build().use { client ->
                    fun request(token: String = config.accessToken, body: String? = null): HttpResponse<String> {
                        val builder = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/car?token=$token"))
                            .timeout(Duration.ofSeconds(5))
                        if (body != null) builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body))
                        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
                    }

                    val original = server.branding.settings
                    assertEquals(403, request(token = "").statusCode())
                    assertEquals(403, request(token = "wrong", body = "{}").statusCode())
                    assertEquals(original, server.branding.settings)
                    val defaults = request()
                    assertEquals(200, defaults.statusCode())
                    assertTrue(defaults.body().contains("\"showBackButton\":false"))
                    assertTrue(defaults.body().contains("\"logo\":null"))
                    assertTrue(defaults.body().contains("\"rightHandDrive\":false"))
                    assertEquals(503, request(body = """{"manufacturer":"Toyota","title":"Car"}""").statusCode())

                    server.hub.onApplyBranding = server::applyBranding
                    assertEquals(400, request(body = "not json").statusCode())
                    assertEquals(400, request(body = """{"manufacturer":"","title":"Car"}""").statusCode())
                    assertEquals(400, request(body = """{"manufacturer":"Toyota","title":"Car","logo":"not an image"}""").statusCode())
                    assertEquals(original, server.branding.settings)

                    val settings = CarBranding("Toyota", "My \"car\"", true, rightHandDrive = true)
                    val saved = request(body = Json.encodeToString(CarBranding.serializer(), settings))
                    assertEquals(200, saved.statusCode())
                    assertEquals("""{"ok":true}""", saved.body())
                    assertEquals(settings, Json.decodeFromString(CarBranding.serializer(), request().body()))
                    assertEquals(settings.title, ConfigStore(config.stateDir).load()!!.oemLabel)
                    assertTrue(server.airPlayConfig.rightHandDrive)
                    assertTrue(ConfigStore(config.stateDir).load()!!.rightHandDrive)

                    for (invalidSide in listOf("\"right\"", "null", "1")) {
                        assertEquals(400, request(body = """{"manufacturer":"Toyota","title":"Car","rightHandDrive":$invalidSide}""").statusCode())
                        assertEquals(settings, server.branding.settings)
                        assertTrue(ConfigStore(config.stateDir).load()!!.rightHandDrive)
                    }
                    // A viewer from before driver-side support must not reset a right-hand-drive car.
                    assertEquals(200, request(body = """{"manufacturer":"Toyota","title":"Legacy viewer"}""").statusCode())
                    assertTrue(server.branding.settings.rightHandDrive)
                    assertTrue(ConfigStore(config.stateDir).load()!!.rightHandDrive)
                    val left = server.branding.settings.copy(rightHandDrive = false)
                    val leftBody = Json { encodeDefaults = true }.encodeToString(CarBranding.serializer(), left)
                    assertEquals(200, request(body = leftBody).statusCode())
                    assertEquals(left, Json.decodeFromString(CarBranding.serializer(), request().body()))
                    assertFalse(server.airPlayConfig.rightHandDrive)
                    assertFalse(ConfigStore(config.stateDir).load()!!.rightHandDrive)
                }
            } finally {
                http.stop(0, 1000)
            }
        }
    }
}
