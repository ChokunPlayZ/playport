package com.playport.server

import kotlinx.serialization.Serializable

/** Setup progress only: a Wi-Fi handoff request is not evidence of an active CarPlay session. */
@Serializable
data class ConnectionStatus(
    val stage: String,
    val detail: String? = null,
    val wifiSsid: String? = null,
    val wirelessEnabled: Boolean = true,
)
