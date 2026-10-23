package com.sportzfy.live.domain.model

/** A 24/7 TV channel from the channel directory (`channels.json`). */
data class Channel(
    /** Slug of the name, unique within the directory; used as the route argument. */
    val id: String,
    val name: String,
    val logoUrl: String?,
    val category: ChannelCategory,
    /** http(s) page or media stream (HLS, DASH, MPEG-TS…), played by the existing player. */
    val streamUrl: String,
    /** Set by `"type"` in the channel list; null lets the URL's extension decide. */
    val streamFormat: StreamFormat? = null,
    /**
     * Country or region the playlist files the channel under (an M3U
     * `group-title` such as "Italy", or a JSON `country`); null when it gives none.
     */
    val country: String? = null,
    /**
     * The directory's `sandbox` flag: run this channel's page in a sandboxed
     * iframe. Read from `channels.json`; M3U playlists carry no such flag.
     * The owner can also sandbox every channel via the app's remote config.
     */
    val sandboxed: Boolean = false,
    /**
     * ClearKey license URL for a DRM'd DASH channel — the Worker's
     * `/api/drm/tv/:id` route, emitted as the playlist's `drm` attribute.
     * The app points the ClearKey CDM at it and gets the channel's key pair
     * back; the playlist itself never carries key material.
     */
    val drmLicenseUrl: String? = null,
) {
    /** Host serving the stream, shown as the channel's source. */
    val sourceHost: String
        get() = streamUrl.substringAfter("://")
            .substringBefore('/')
            .substringBefore('?')
            .substringBefore('#')
            .substringAfterLast('@')
            .substringBefore(':')
            .lowercase()
}

/** Live TV filter groups. Every channel belongs to exactly one. */
enum class ChannelCategory(val label: String) {
    FOOTBALL("Football"),
    CRICKET("Cricket"),
    OTHERS("Others"),
}

/** Snapshot of the channel directory; keeps the last good list when a refresh fails. */
data class ChannelFeed(
    val channels: List<Channel>,
    val updatedAtMillis: Long?,
    val isLoading: Boolean,
    val error: DataError?,
) {
    companion object {
        val Initial = ChannelFeed(channels = emptyList(), updatedAtMillis = null, isLoading = false, error = null)
    }
}
