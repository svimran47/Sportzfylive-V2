package com.sportzfy.live.data.channels

import com.sportzfy.live.core.network.NetworkJson
import com.sportzfy.live.domain.model.ChannelCategory
import com.sportzfy.live.domain.model.StreamFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChannelParserTest {

    private fun entry(name: String, url: String, logo: String = "https://img.example/$name.png", category: String? = null) =
        """{"name":"$name","logo":"$logo","genre":"Sports","url":"$url"${category?.let { ""","category":"$it"""" } ?: ""}}"""

    private fun parse(raw: String) = ChannelParser.parse(NetworkJson, raw)

    @Test
    fun `reads the JavaScript-wrapped directory`() {
        val raw = "const channels = [\n  ${entry("ESPN", "https://tv.example/espn")},\n  ${entry("TNT", "https://tv.example/tnt")}\n];\n"
        val channels = parse(raw)!!
        assertEquals(listOf("ESPN", "TNT"), channels.map { it.name })
        assertEquals("https://tv.example/espn", channels.first().streamUrl)
        assertEquals("tv.example", channels.first().sourceHost)
    }

    @Test
    fun `reads a plain JSON array too`() {
        assertEquals(1, parse("[${entry("ESPN", "https://tv.example/espn")}]")!!.size)
    }

    @Test
    fun `reads the website's sandbox flag without dropping a channel`() {
        val raw = """[
          {"name":"Plain","url":"https://tv.example/plain"},
          {"name":"Boxed","url":"https://tv.example/boxed","sandbox":true},
          {"name":"Quoted","url":"https://tv.example/quoted","sandbox":"true"},
          {"name":"Odd","url":"https://tv.example/odd","sandbox":1},
          {"name":"Off","url":"https://tv.example/off","sandbox":false}
        ]"""
        val channels = parse(raw)!!
        assertEquals(listOf("Plain", "Boxed", "Quoted", "Odd", "Off"), channels.map { it.name })
        assertEquals(listOf(false, true, true, false, false), channels.map { it.sandboxed })
    }

    @Test
    fun `unreadable input is rejected rather than read as empty`() {
        assertNull(parse("<html>rate limited</html>"))
        assertNull(parse("const channels = [ {broken ];"))
    }

    @Test
    fun `decodes repeatedly escaped ampersands in logo URLs`() {
        val logo = "https://img.example/a.jpg?w=3840&amp;amp;amp;amp;q=75"
        val channel = parse("[${entry("beIN Sports", "https://tv.example/bein", logo)}]")!!.single()
        assertEquals("https://img.example/a.jpg?w=3840&q=75", channel.logoUrl)
    }

    @Test
    fun `skips entries without a name or an http(s) stream, and repeated streams`() {
        val raw = """[
            ${entry("Good", "https://tv.example/good")},
            {"url":"https://tv.example/nameless"},
            ${entry("Plain http", "http://tv.example/http")},
            ${entry("Not web", "rtmp://tv.example/live")},
            ${entry("Script", "javascript:alert(1)")},
            ${entry("Copy", "https://tv.example/good")}
        ]"""
        assertEquals(listOf("Good", "Plain http"), parse(raw)!!.map { it.name })
    }

    @Test
    fun `a type field sets the stream format, read loosely`() {
        val raw = """[
            {"name":"IPTV","url":"http://iptv.example:8080/u/p/123","type":"ts"},
            {"name":"Dash","url":"https://cdn.example/play?id=1","type":" DASH "},
            {"name":"Odd","url":"https://tv.example/odd","type":5},
            {"name":"Unknown","url":"https://tv.example/unknown","type":"rtmp"},
            {"name":"None","url":"https://tv.example/none"}
        ]"""
        assertEquals(
            listOf(StreamFormat.PROGRESSIVE, StreamFormat.DASH, null, null, null),
            parse(raw)!!.map { it.streamFormat },
        )
    }

    @Test
    fun `reads M3U playlists`() {
        val raw = "\uFEFF#EXTM3U x-tvg-url=\"https://epg.example/guide.xml\"\n" +
            "#EXTINF:-1 tvg-id=\"sky.uk\" tvg-logo=\"https://img.example/sky.png\" group-title=\"UK Football\",Sky Sports Main Event\n" +
            "#EXTVLCOPT:http-referrer=https://tv.example/\n" +
            "http://iptv.example:8080/live/u/p/1.ts\n" +
            "\n" +
            "#EXTINF:-1 tvg-name=\"Willow\" tvg-logo=\"http://img.example/w.png\",\n" +
            "#EXTGRP:Cricket\n" +
            "https://cdn.example/willow/index.m3u8\r\n" +
            "#EXTINF:-1 group-title=\"News, World\",BBC, One\n" +
            "https://cdn.example/bbc/manifest.mpd\n" +
            "https://cdn.example/orphan.m3u8\n" +
            "#EXTINF:-1,No URL\n"
        val channels = parse(raw)!!
        assertEquals(listOf("Sky Sports Main Event", "Willow", "BBC, One"), channels.map { it.name })
        assertEquals(
            listOf("http://iptv.example:8080/live/u/p/1.ts", "https://cdn.example/willow/index.m3u8", "https://cdn.example/bbc/manifest.mpd"),
            channels.map { it.streamUrl },
        )
        assertEquals(listOf("https://img.example/sky.png", "http://img.example/w.png", null), channels.map { it.logoUrl })
        // The group doubles as the country: sports.m3u files every channel under one.
        assertEquals(listOf("UK Football", "Cricket", "News, World"), channels.map { it.country })
        assertEquals(
            listOf(ChannelCategory.FOOTBALL, ChannelCategory.CRICKET, ChannelCategory.OTHERS),
            channels.map { it.category },
        )
        assertEquals(listOf<StreamFormat?>(null, null, null), channels.map { it.streamFormat })
    }

    @Test
    fun `an M3U type attribute sets the stream format, read loosely`() {
        val raw = "#EXTM3U\n" +
            "#EXTINF:-1 tvg-name=\"Alpha\" group-title=\"Sports\" type=\"hls\",Alpha\n" +
            "https://tv.example/api/play/tv/alpha\n" +
            "#EXTINF:-1 type=\" dash \",Dash\n" +
            "https://cdn.example/manifest\n" +
            "#EXTINF:-1 type=\"rtmp\",Unknown\n" +
            "https://tv.example/unknown\n" +
            "#EXTINF:-1,Untyped\n" +
            "https://tv.example/untyped\n"
        val channels = parse(raw)!!
        assertEquals(
            listOf(StreamFormat.HLS, StreamFormat.DASH, null, null),
            channels.map { it.streamFormat },
        )
        // The page's entries classify by extension; a type hint wins there too.
        assertEquals(listOf("https://tv.example/api/play/tv/alpha"), channels.take(1).map { it.streamUrl })
    }

    @Test
    fun `an M3U drm attribute becomes the ClearKey license URL, validated like any URL`() {
        val raw = "#EXTM3U\n" +
            "#EXTINF:-1 tvg-name=\"Nova\" type=\"dash\" drm=\"https://worker.example/api/drm/tv/nova\",Nova\n" +
            "https://cdn.example/nova.mpd\n" +
            "#EXTINF:-1 tvg-name=\"Relative\" drm=\"/api/drm/tv/relative\"\n" +
            "https://cdn.example/relative.mpd\n" +
            "#EXTINF:-1 tvg-name=\"Plain drm=\" drm=\"not a url\"\n" +
            "https://cdn.example/plain.mpd\n" +
            "#EXTINF:-1 tvg-name=\"Untagged\"\n" +
            "https://cdn.example/untagged.mpd\n"
        val channels = parse(raw)!!
        assertEquals(
            listOf(
                "https://worker.example/api/drm/tv/nova",
                null,
                null,
                null,
            ),
            channels.map { it.drmLicenseUrl },
        )
        assertEquals(
            listOf(StreamFormat.DASH, StreamFormat.DASH, StreamFormat.DASH, null),
            channels.map { it.streamFormat },
        )
    }

    @Test
    fun `a JSON drm field becomes the ClearKey license URL`() {
        val raw = """[
            {"name":"Aiv","url":"https://cdn.example/aiv.mpd","drm":"https://worker.example/api/drm/tv/aiv"},
            {"name":"Broken","url":"https://cdn.example/broken.mpd","drm":"javascript:alert(1)"}
        ]"""
        val channels = parse(raw)!!
        assertEquals("https://worker.example/api/drm/tv/aiv", channels[0].drmLicenseUrl)
        assertNull(channels[1].drmLicenseUrl)
    }

    @Test
    fun `an M3U playlist with no entries is an empty list, not an error`() {
        assertEquals(emptyList<Any>(), parse("#EXTM3U\n"))
    }

    @Test
    fun `plain http logos are kept, anything else is dropped`() {
        val http = parse("[${entry("ESPN", "https://tv.example/espn", "http://img.example/espn.png")}]")!!.single()
        assertEquals("http://img.example/espn.png", http.logoUrl)
        val other = parse("[${entry("ESPN", "https://tv.example/espn", "ftp://img.example/espn.png")}]")!!.single()
        assertNull(other.logoUrl)
    }

    @Test
    fun `JSON entries may name a country`() {
        val raw = """[{"name":"Rai Sport","url":"https://tv.example/rai","country":"Italy"},{"name":"ESPN","url":"https://tv.example/espn"}]"""
        assertEquals(listOf("Italy", null), parse(raw)!!.map { it.country })
    }

    @Test
    fun `ids are unique slugs of the name`() {
        val raw = "[${entry("Sky Sports+", "https://tv.example/1")}, ${entry("Sky Sports +", "https://tv.example/2")}]"
        assertEquals(listOf("sky-sports", "sky-sports-2"), parse(raw)!!.map { it.id })
    }

    @Test
    fun `groups channels by name when no category is given`() {
        fun category(name: String) = ChannelParser.categoryOf(null, name)
        assertEquals(ChannelCategory.CRICKET, category("Sky Sports Cricket"))
        assertEquals(ChannelCategory.CRICKET, category("Willow Cricket 2"))
        assertEquals(ChannelCategory.CRICKET, category("Fox Sports 501 (Cricket)"))
        assertEquals(ChannelCategory.FOOTBALL, category("Sky Sports Football"))
        assertEquals(ChannelCategory.FOOTBALL, category("Sky Sports Premier League"))
        assertEquals(ChannelCategory.FOOTBALL, category("DAZN LaLiga"))
        assertEquals(ChannelCategory.FOOTBALL, category("Sky Sport Bundesliga"))
        assertEquals(ChannelCategory.FOOTBALL, category("SPORTDIGITAL FUSSBALL"))
        // "Footy" is Australian rules, and "PL" here is Poland, not the Premier League.
        assertEquals(ChannelCategory.OTHERS, category("Fox Sports 504 (Footy)"))
        assertEquals(ChannelCategory.OTHERS, category("CANAL+ Sport PL"))
        assertEquals(ChannelCategory.OTHERS, category("Cartoon Network"))
    }

    @Test
    fun `an explicit category wins over the name`() {
        val raw = "[${entry("ESPN", "https://tv.example/espn", category = "Football")}, ${entry("Willow", "https://tv.example/w", category = "other")}]"
        assertEquals(listOf(ChannelCategory.FOOTBALL, ChannelCategory.OTHERS), parse(raw)!!.map { it.category })
    }
}
