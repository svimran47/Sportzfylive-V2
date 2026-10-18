package com.sportzfy.live.core.player

import com.sportzfy.live.domain.model.EmbedUrl
import com.sportzfy.live.domain.model.StreamFormat

/** A media URL captured while an embed page resolved itself, ready for Media3. */
data class ResolvedStream(
    val url: String,
    val format: StreamFormat,
    /** Headers the embed used (Referer, Cookie…), so Media3 can replay the request. */
    val headers: Map<String, String>,
)

/**
 * Reads the media manifest out of the requests an embed page makes.
 *
 * Streamed's match embeds only hand out an `embed.st` page; the real
 * `.m3u8`/`.mpd` URL is built inside the page's obfuscated JavaScript at play
 * time and never appears in the markup (see the root README, *Match streams*).
 * The one place it is visible is the request the page issues for it, so
 * [resolve] recognises that request while the embed runs in a hidden WebView;
 * Media3 then plays it directly, with no web player and no ads.
 */
object EmbedManifest {

    /** Request headers worth replaying, matched case-insensitively. */
    private val FORWARDED = setOf("referer", "origin", "cookie", "user-agent")

    /** True for a page the resolver should run: the app's known embed host. */
    fun isEmbedPlayer(url: String): Boolean = hostOf(url) == EmbedUrl.HOST

    /** The stream behind [url], or null when the request is not a media manifest. */
    fun resolve(url: String, requestHeaders: Map<String, String>): ResolvedStream? {
        val format = formatOf(url) ?: return null
        return ResolvedStream(url, format, forwardHeaders(requestHeaders))
    }

    /** HLS for an `.m3u8`/`.m3u`, DASH for an `.mpd`; null for anything else (segments included). */
    fun formatOf(url: String): StreamFormat? {
        val lower = url.lowercase()
        val path = lower.substringBefore('?').substringBefore('#')
        return when {
            path.endsWith(".m3u8") || path.endsWith(".m3u") || "format=m3u8" in lower -> StreamFormat.HLS
            path.endsWith(".mpd") || "format=mpd" in lower -> StreamFormat.DASH
            else -> null
        }
    }

    /** The forwarded subset of [requestHeaders], with the names Media3 expects. */
    fun forwardHeaders(requestHeaders: Map<String, String>): Map<String, String> =
        requestHeaders.entries
            .filter { it.key.lowercase() in FORWARDED }
            .associate { it.key to it.value }

    private fun hostOf(url: String): String? {
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) return null
        return url.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#')
            .substringAfterLast('@').substringBefore(':').lowercase()
    }
}
