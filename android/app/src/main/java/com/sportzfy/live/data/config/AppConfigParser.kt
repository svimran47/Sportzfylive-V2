package com.sportzfy.live.data.config

import com.sportzfy.live.domain.model.Announcement
import com.sportzfy.live.domain.model.AppConfig
import com.sportzfy.live.domain.model.PlayerMode
import com.sportzfy.live.domain.model.SportCategory
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Wire shape of `remote-config.json`. Every field is optional. */
@Serializable
internal data class RemoteConfigDto(
    val announcement: AnnouncementDto? = null,
    val featuredMatchId: String? = null,
    val hiddenCategories: List<String>? = null,
    val adBlocking: Boolean? = null,
    val extraBlockedHosts: List<String>? = null,
    val playerMode: String? = null,
    val embedSandbox: Boolean? = null,
    val embedResolve: Boolean? = null,
    val minVersionCode: Int? = null,
    val updateUrl: String? = null,
    val maintenance: MaintenanceDto? = null,
    val channelsUrl: String? = null,
    val streamProxyUrl: String? = null,
)

@Serializable
internal data class AnnouncementDto(val message: String? = null, val url: String? = null)

@Serializable
internal data class MaintenanceDto(val enabled: Boolean? = null, val message: String? = null)

object AppConfigParser {

    private const val DEFAULT_MAINTENANCE_MESSAGE = "Sportzfy is down for maintenance. Please check back soon."

    /** Returns null for anything that is not a valid config object. */
    fun parse(json: Json, raw: String): AppConfig? {
        val dto = runCatching { json.decodeFromString(RemoteConfigDto.serializer(), raw) }.getOrNull() ?: return null
        return AppConfig(
            announcement = dto.announcement?.let { banner ->
                banner.message?.trim()?.takeIf { it.isNotEmpty() }?.let { Announcement(it, httpsOrNull(banner.url)) }
            },
            featuredMatchId = dto.featuredMatchId?.trim()?.takeIf { it.isNotEmpty() },
            hiddenCategories = dto.hiddenCategories.orEmpty()
                .filter { it.isNotBlank() }
                .map { SportCategory.fromApiKey(it) to it }
                // A typo must not silently hide the whole "Other" category.
                .filter { (category, key) -> category != SportCategory.OTHER || key.trim().equals("other", ignoreCase = true) }
                .map { it.first }
                .toSet(),
            adBlocking = dto.adBlocking ?: false,
            extraBlockedHosts = dto.extraBlockedHosts.orEmpty()
                .map { it.trim().lowercase().removePrefix("*.").trimEnd('.') }
                .filter { it.isNotEmpty() && it.none(Char::isWhitespace) && '/' !in it }
                .toSet(),
            playerMode = when (dto.playerMode?.trim()?.lowercase()) {
                "iframe" -> PlayerMode.IFRAME
                else -> PlayerMode.DIRECT
            },
            // Missing means the app's own default, which sandboxes.
            embedSandbox = dto.embedSandbox ?: true,
            embedResolve = dto.embedResolve ?: true,
            minVersionCode = dto.minVersionCode?.coerceAtLeast(0) ?: 0,
            updateUrl = httpsOrNull(dto.updateUrl),
            maintenanceMessage = dto.maintenance?.takeIf { it.enabled == true }?.let {
                it.message?.trim()?.takeIf(String::isNotEmpty) ?: DEFAULT_MAINTENANCE_MESSAGE
            },
            channelsUrl = httpsOrNull(dto.channelsUrl) ?: AppConfig.DEFAULT_CHANNELS_URL,
            // Missing means the default Worker; "" turns the fallback off.
            streamProxyUrl = when (val raw = dto.streamProxyUrl?.trim()) {
                null -> AppConfig.DEFAULT_STREAM_PROXY_URL
                "" -> null
                else -> httpsOrNull(raw) ?: AppConfig.DEFAULT_STREAM_PROXY_URL
            },
        )
    }

    private fun httpsOrNull(url: String?): String? =
        url?.trim()?.takeIf { it.startsWith("https://", ignoreCase = true) }
}
