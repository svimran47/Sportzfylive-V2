package com.sportzfy.live.core.player

import com.sportzfy.live.domain.model.EmbedUrl

/**
 * Decides what the embed WebView may navigate to and load, for any stream
 * URL the app plays.
 *
 * - The top-level page stays on the active stream's host ([streamUrl]), on
 *   [trustedHosts], or on the host its first load landed on after server
 *   redirects. Ads hijack the page with `top.location` or a pop-up; with
 *   pop-ups trapped by the WebView, both arrive here as main-frame
 *   navigations to another site and are cancelled.
 * - Subframes load from any host or scheme, because embeds nest their real
 *   player in cross-domain iframes — except the ad networks themselves,
 *   whose frames are the ads. An ad iframe is refused, a player iframe is not.
 * - At the top level, other schemes (`intent:`, `market:`, `tel:`, `file:`,
 *   `data:` and so on) never load; `about:blank` does.
 * - Sub-resources (frames, images, XHR, beacons) from [blockedResourceHosts]
 *   are refused; the WebView answers them with an empty success. Scripts are
 *   never refused: the embeds' inline player setup calls into their ad
 *   scripts (`acscdn`'s `aclib.js` and the like), and a black player is all
 *   that is left when one of them is missing.
 */
class PlayerUrlPolicy(
    streamUrl: String? = null,
    private val trustedHosts: Set<String> = setOf(EmbedUrl.HOST),
    private val blockedHosts: Set<String> = AdHosts.DEFAULT,
    private val blockedResourceHosts: Set<String> = blockedHosts,
) {

    enum class Decision { ALLOW, BLOCK }

    private val streamDomain: String? = streamUrl?.let(::hostOf)?.let(::siteDomain)

    /**
     * [pageHost] is the host the player's page landed on, and [landing] is
     * true while that first load is still following server redirects.
     */
    fun navigation(
        url: String,
        isMainFrame: Boolean,
        isRedirect: Boolean = false,
        pageHost: String? = null,
        landing: Boolean = false,
    ): Decision {
        val parsed = parse(url)
        if (!isMainFrame) {
            // Nested players live in cross-domain iframes: any host or scheme
            // loads, except that an ad network's frame is the ad itself.
            val host = parsed?.host ?: return Decision.ALLOW
            return if (parsed.isHttp && host.matchesAny(blockedHosts)) Decision.BLOCK else Decision.ALLOW
        }
        if (parsed == null) return Decision.BLOCK
        return when (parsed.scheme) {
            "about" -> if (parsed.rest == "blank" || parsed.rest == "srcdoc") Decision.ALLOW else Decision.BLOCK
            "http", "https" -> {
                val host = parsed.host
                when {
                    host == null || host.matchesAny(blockedHosts) -> Decision.BLOCK
                    // The stream's own server may send its first load elsewhere (a mirror, a CDN page).
                    landing && isRedirect -> Decision.ALLOW
                    host.matchesAny(mainFrameDomains(pageHost)) -> Decision.ALLOW
                    else -> Decision.BLOCK
                }
            }
            else -> Decision.BLOCK
        }
    }

    /**
     * Whether a sub-resource request may load. [destination] is the request's
     * `Sec-Fetch-Dest` header when the WebView reports one (`"script"`,
     * `"iframe"`, `"image"`, `"empty"` …), and [accept] its `Accept` header;
     * both are null on WebViews that don't expose them, and there the URL and
     * `Accept` are all the hints there are.
     */
    fun resource(url: String, destination: String? = null, accept: String? = null): Decision {
        val host = parse(url)?.host ?: return Decision.ALLOW
        if (!host.matchesAny(blockedResourceHosts)) return Decision.ALLOW
        return if (isScriptRequest(url, destination, accept)) Decision.ALLOW else Decision.BLOCK
    }

    /**
     * True for a request the page made for a script, which ad filtering never
     * refuses. `Sec-Fetch-Dest` decides when the WebView reports it; otherwise
     * the URL and `Accept` do, and a request that looks like neither a script
     * nor a document, image or media file is left alone rather than risk the
     * black player a missing ad script leaves behind.
     */
    private fun isScriptRequest(url: String, destination: String?, accept: String?): Boolean {
        val dest = destination?.trim()?.lowercase()
        if (!dest.isNullOrEmpty()) return dest == "script"
        val path = url.substringBefore('#').substringBefore('?').lowercase()
        if (path.endsWith(".js") || path.endsWith(".mjs")) return true
        val type = accept?.lowercase().orEmpty()
        if ("javascript" in type) return true
        // A frame's document or an image/beacon is not a script; anything else
        // (a bare `*/*` XHR) is left to load.
        return !("text/html" in type || "image/" in type || "video/" in type || "audio/" in type)
    }

    private fun mainFrameDomains(pageHost: String?): Set<String> =
        trustedHosts + listOfNotNull(streamDomain, pageHost?.let(::siteDomain))

    private class ParsedUrl(val scheme: String, val host: String?, val rest: String) {
        val isHttp: Boolean get() = scheme == "http" || scheme == "https"
    }

    private fun hostOf(url: String): String? = parse(url)?.host

    /** `www.` is dropped so the bare domain and its other subdomains count as the same site. */
    private fun siteDomain(host: String): String = host.lowercase().trimEnd('.').removePrefix("www.")

    private fun parse(url: String): ParsedUrl? {
        val trimmed = url.trim()
        val colon = trimmed.indexOf(':')
        if (colon <= 0) return null
        val scheme = trimmed.substring(0, colon).lowercase()
        if (!scheme.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }) return null
        val rest = trimmed.substring(colon + 1)
        if (!rest.startsWith("//")) return ParsedUrl(scheme, host = null, rest = rest)

        // authority = [userinfo@]host[:port], ending at the first / ? or #
        val authority = rest.substring(2).takeWhile { it != '/' && it != '?' && it != '#' && it != '\\' }
        val hostPort = authority.substringAfterLast('@')
        val host = if (hostPort.startsWith("[")) {
            hostPort.substringBefore(']') + "]"
        } else {
            hostPort.substringBefore(':')
        }
        return ParsedUrl(scheme, host.lowercase().trimEnd('.').ifEmpty { null }, rest)
    }

    private fun String.matchesAny(domains: Set<String>): Boolean =
        domains.any { domain -> this == domain || endsWith(".$domain") }
}
