package com.sportzfy.live.data.channels

import com.sportzfy.live.domain.model.Channel
import com.sportzfy.live.domain.model.ChannelCategory
import com.sportzfy.live.domain.model.StreamFormat
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * One entry of `channels.json`. `category` is optional and overrides name-based grouping.
 * `sandbox` marks a channel whose page must run in a sandboxed iframe; it is read
 * loosely, so any value other than true (boolean or the string "true") leaves the
 * channel unsandboxed and a wrong type never drops the channel. `type`
 * (`"hls"`, `"dash"`, `"ts"`, `"embed"`…) says how to play a URL whose extension
 * doesn't, like an IPTV feed at `http://host:8080/user/pass/123`.
 */
@Serializable
internal data class ChannelDto(
    val name: String? = null,
    val logo: String? = null,
    val genre: String? = null,
    val url: String? = null,
    val category: String? = null,
    val sandbox: JsonElement? = null,
    val type: JsonElement? = null,
    val country: String? = null,
    val drm: String? = null,
)

private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** True only for the boolean `true` or the string `"true"`; anything else stays off. */
private fun JsonElement?.isTrue(): Boolean =
    (this as? JsonPrimitive)?.content?.equals("true", ignoreCase = true) == true

/** A channel as read from either list format, before validation. */
private class RawChannel(
    val name: String?,
    val logo: String?,
    val url: String?,
    val category: String?,
    val format: StreamFormat? = null,
    val country: String? = null,
    val sandboxed: Boolean = false,
    val drm: String? = null,
)

/**
 * Reads the channel directory. `channels.json` is a JavaScript snippet
 * (`const channels = [...];`), so the outermost JSON array is cut out of it
 * first; a plain JSON array works too. An M3U playlist (`#EXTM3U` with
 * `#EXTINF` entries, as IPTV providers publish) is read as well: the title,
 * `tvg-logo` and `group-title` (or `#EXTGRP`) of each entry, a `type`
 * attribute (`"hls"`…) when the entry names one — as the Worker's
 * `/api/tv/playlist.m3u` does for the short-link player pages it routes
 * through `/api/play/tv/:id` — and a `drm` attribute for a ClearKey DASH
 * channel's license route. The group is
 * read as the channel's country as well, which is how `sports.m3u` files them.
 *
 * Entries without a name or an http(s) stream URL are skipped, as are repeated
 * stream URLs. `genre` is "Sports" for every channel upstream (cartoons
 * included), so it can't group channels: [categoryOf] uses an explicit
 * `category` field when present, otherwise the channel name.
 */
object ChannelParser {

    private val CRICKET = Regex("""\b(cricket|willow)\b""")
    private val FOOTBALL = Regex(
        """\b(football|fussball|fußball|soccer|laliga|la liga|bundesliga|premier league|serie a|ligue 1|eredivisie)\b"""
    )

    private val M3U_ATTRIBUTE = Regex("""([A-Za-z0-9_-]+)="([^"]*)"""")

    /** Returns null when [raw] is neither an M3U playlist nor holds a readable JSON array. */
    fun parse(json: Json, raw: String): List<Channel>? {
        val entries = if (isM3u(raw)) parseM3u(raw) else parseJson(json, raw) ?: return null
        return build(entries)
    }

    private fun parseJson(json: Json, raw: String): List<RawChannel>? {
        val start = raw.indexOf('[')
        val end = raw.lastIndexOf(']')
        if (start < 0 || end <= start) return null
        val array = runCatching { json.parseToJsonElement(raw.substring(start, end + 1)) }.getOrNull() as? JsonArray
            ?: return null
        return array.mapNotNull { entry ->
            val dto = runCatching { json.decodeFromJsonElement(ChannelDto.serializer(), entry) }.getOrNull()
                ?: return@mapNotNull null
            RawChannel(
                name = dto.name,
                logo = dto.logo,
                url = dto.url,
                category = dto.category,
                format = StreamFormat.fromHint(dto.type.text()),
                country = dto.country,
                sandboxed = dto.sandbox.isTrue(),
                drm = dto.drm,
            )
        }
    }

    private fun isM3u(raw: String): Boolean {
        val first = raw.trimStart('\uFEFF').lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return false
        return first.startsWith("#EXTM3U", ignoreCase = true) || first.startsWith("#EXTINF", ignoreCase = true)
    }

    private fun parseM3u(raw: String): List<RawChannel> {
        val entries = ArrayList<RawChannel>()
        var info: String? = null
        var group: String? = null
        for (line in raw.trimStart('\uFEFF').lineSequence().map { it.trim() }) {
            when {
                line.isEmpty() -> Unit
                line.startsWith("#EXTINF", ignoreCase = true) -> {
                    info = line.substringAfter(':', "")
                    group = null
                }
                line.startsWith("#EXTGRP:", ignoreCase = true) -> group = line.substringAfter(':').trim()
                line.startsWith("#") -> Unit
                else -> {
                    // A URL line closes the entry it belongs to; one without #EXTINF has no name.
                    val current = info ?: continue
                    val comma = titleComma(current)
                    val attributes = M3U_ATTRIBUTE.findAll(if (comma >= 0) current.substring(0, comma) else current)
                        .associate { it.groupValues[1].lowercase() to it.groupValues[2] }
                    val title = if (comma >= 0) current.substring(comma + 1) else null
                    val groupTitle = attributes["group-title"]?.takeIf { it.isNotBlank() } ?: group
                    entries += RawChannel(
                        name = title?.takeIf { it.isNotBlank() } ?: attributes["tvg-name"],
                        logo = attributes["tvg-logo"],
                        url = line,
                        category = groupTitle,
                        // sports.m3u files every channel under its country.
                        country = groupTitle,
                        // A `type` attribute (the Worker's playlist) marks entries
                        // whose URL has no media extension, e.g. the play route
                        // for short-link channels.
                        format = StreamFormat.fromHint(attributes["type"]),
                        // The Worker's playlist carries a ClearKey DASH
                        // channel's license route here.
                        drm = attributes["drm"],
                    )
                    info = null
                    group = null
                }
            }
        }
        return entries
    }

    /** Index of the comma that starts an `#EXTINF` title: the first one outside quoted attributes, or -1. */
    private fun titleComma(info: String): Int {
        var quoted = false
        info.forEachIndexed { index, char ->
            when {
                char == '"' -> quoted = !quoted
                char == ',' && !quoted -> return index
            }
        }
        return -1
    }

    private fun build(entries: List<RawChannel>): List<Channel> {
        val seenUrls = HashSet<String>()
        val idCounts = HashMap<String, Int>()
        return entries.mapNotNull { entry ->
            val name = entry.name?.let(::decodeEntities)?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val url = entry.url?.trim()?.takeIf { isHttpUrl(it) } ?: return@mapNotNull null
            if (!seenUrls.add(url)) return@mapNotNull null

            val base = slug(name).ifEmpty { "channel" }
            val count = (idCounts[base] ?: 0) + 1
            idCounts[base] = count
            Channel(
                id = if (count == 1) base else "$base-$count",
                name = name,
                logoUrl = entry.logo?.let(::decodeEntities)?.trim()?.takeIf { isHttpUrl(it) },
                category = categoryOf(entry.category, name),
                streamUrl = url,
                streamFormat = entry.format,
                country = entry.country?.let(::decodeEntities)?.trim()?.takeIf { it.isNotEmpty() },
                sandboxed = entry.sandboxed,
                // The license route must be an http(s) URL; a root-relative
                // string (which only makes sense on the Worker's own site)
                // would break the app, so it is dropped instead.
                drmLicenseUrl = entry.drm?.let(::decodeEntities)?.trim()?.takeIf { isHttpUrl(it) },
            )
        }
    }

    /**
     * An exact `category` wins; otherwise the channel name, then the category
     * text (an M3U `group-title` like "UK Football"), is matched for keywords.
     */
    fun categoryOf(explicit: String?, name: String): ChannelCategory {
        when (explicit?.trim()?.lowercase()) {
            "football", "soccer" -> return ChannelCategory.FOOTBALL
            "cricket" -> return ChannelCategory.CRICKET
            "other", "others" -> return ChannelCategory.OTHERS
        }
        for (text in listOfNotNull(name.lowercase(), explicit?.lowercase())) {
            when {
                CRICKET.containsMatchIn(text) -> return ChannelCategory.CRICKET
                FOOTBALL.containsMatchIn(text) -> return ChannelCategory.FOOTBALL
            }
        }
        return ChannelCategory.OTHERS
    }

    /** Undoes HTML escaping, including the repeated `&amp;amp;…` chains upstream logos carry. */
    internal fun decodeEntities(value: String): String {
        var current = value
        var rounds = 0
        while ("&amp;" in current && rounds++ < 32) current = current.replace("&amp;", "&")
        return current.replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
    }

    private fun isHttps(url: String): Boolean =
        url.startsWith("https://", ignoreCase = true) && url.length > "https://".length && url.none(Char::isWhitespace)

    /**
     * Streams may be plain http (IPTV feeds often are); whether they play is the player's call.
     * Logos may be too: the IPTV picon servers behind `sports.m3u` have no TLS.
     */
    private fun isHttpUrl(url: String): Boolean =
        isHttps(url) || (url.startsWith("http://", ignoreCase = true) && url.length > "http://".length && url.none(Char::isWhitespace))

    private fun slug(name: String): String =
        name.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
}
