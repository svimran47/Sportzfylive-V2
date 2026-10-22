package com.sportzfy.live.domain.model

/**
 * Settings the owner controls remotely from the admin "Android app" page; the
 * Worker serves them at `/api/app/config`. Every installed app picks changes up
 * without an update. `android/remote-config.json` has the same shape; builds
 * from before the Worker config shipped still read that file from GitHub.
 */
data class AppConfig(
    /** Banner shown above the catalog; null hides it. */
    val announcement: Announcement? = null,
    /** Match pinned into the spotlight while it is in today's feed. */
    val featuredMatchId: String? = null,
    /** Sports removed from the catalog entirely. */
    val hiddenCategories: Set<SportCategory> = emptySet(),
    /**
     * Built-in ad-network blocking in the player. Off by default: the stream
     * sites are paid for by their ads and won't play while they're blocked.
     */
    val adBlocking: Boolean = false,
    /** Extra hosts the player refuses, on top of (or instead of) the built-in list. */
    val extraBlockedHosts: Set<String> = emptySet(),
    /**
     * How embeds load. Direct by default: the page opens like a browser tab,
     * which is how Live TV channels already play.
     */
    val playerMode: PlayerMode = PlayerMode.DIRECT,
    /** Builds older than this show an "update required" screen. */
    val minVersionCode: Int = 0,
    val updateUrl: String? = null,
    /** Non-null switches the whole app to a maintenance screen with this message. */
    val maintenanceMessage: String? = null,
    /** Where the Live TV channel directory is loaded from (https only). */
    val channelsUrl: String = DEFAULT_CHANNELS_URL,
    /** The website's Worker, used for streams when streamed.pk blocks the phone; null turns it off. */
    val streamProxyUrl: String? = DEFAULT_STREAM_PROXY_URL,
) {
    fun requiresUpdate(versionCode: Int): Boolean = versionCode < minVersionCode

    companion object {
        const val DEFAULT_STREAM_PROXY_URL = "https://sportzfylive.svimranmy.workers.dev"

        const val DEFAULT_CHANNELS_URL = "https://raw.githubusercontent.com/svimran46/playlist.m3u/main/channels.json"

        val Default = AppConfig()
    }
}

data class Announcement(val message: String, val linkUrl: String?)

enum class PlayerMode {
    /** The embed runs inside a plain, unsandboxed iframe, like the website. */
    IFRAME,

    /** The embed page is loaded directly as the WebView's page, like a browser tab (the default). */
    DIRECT,
}
