package com.sportzfy.live.core.player

import com.sportzfy.live.domain.model.AppConfig
import com.sportzfy.live.domain.model.PlayerMode

/** Player behaviour derived from the remote [AppConfig]. */
data class PlayerConfig(
    val mode: PlayerMode = PlayerMode.DIRECT,
    /** Hosts the top-level page may never navigate to, and whose iframes are refused. */
    val blockedHosts: Set<String> = AdHosts.ALWAYS_BLOCKED + AdHosts.DEFAULT,
    /**
     * Hosts whose sub-resources are refused: frames, images, beacons and XHR.
     * Defaults to [blockedHosts]. Their scripts still load, because the embeds'
     * inline player setup calls into them (acscdn's `aclib.js` and the like)
     * and refusing the script leaves a black player (see [PlayerUrlPolicy]).
     */
    val blockedResourceHosts: Set<String> = blockedHosts,
    /**
     * Referer sent when the page is loaded directly; null (the default) sends
     * none, as a browser tab and the website's `no-referrer` iframe do. Some
     * embeds (embed.st's `admin` streams) stay black when they are loaded as
     * the top-level page with streamed.pk as the referer.
     */
    val referer: String? = null,
    /** Plain-http streams and pages may play. Cleartext is allowed app-wide; this is the switch. */
    val allowHttpStreams: Boolean = true,
    /** DASH and progressive (MPEG-TS, MP4…) streams play in Media3. HLS and web pages always do. */
    val extendedFormats: Boolean = true,
    /**
     * Runs the embed in a sandboxed iframe ([EmbedFrame.SANDBOX]) instead of
     * loading it directly. A sandbox needs a frame, so this forces the iframe
     * wrapper even in [PlayerMode.DIRECT]. The embed's anti-sandbox check
     * passes because the pop-up shim never lets `window.open` answer `null`;
     * in exchange pop-ups, top-level navigation, downloads and pointer lock
     * are refused by the frame itself, not just by the WebView.
     */
    val sandboxed: Boolean = false,
    /**
     * Tries to play an `embed.st` page's real stream in Media3 instead of the
     * web player: a hidden WebView runs the embed just long enough for its
     * JavaScript to ask for the media manifest, which is captured and handed
     * to the native player (no ads, picture-in-picture, background audio). A
     * page the resolver can't work out falls back to the WebView as before.
     */
    val resolveEmbeds: Boolean = true,
) {
    companion object {
        fun from(config: AppConfig): PlayerConfig {
            val blocked = AdHosts.ALWAYS_BLOCKED +
                (if (config.adBlocking) AdHosts.DEFAULT else emptySet()) +
                config.extraBlockedHosts
            return PlayerConfig(
                mode = config.playerMode,
                blockedHosts = blocked,
                blockedResourceHosts = blocked,
                sandboxed = config.embedSandbox,
                resolveEmbeds = config.embedResolve,
            )
        }
    }
}
