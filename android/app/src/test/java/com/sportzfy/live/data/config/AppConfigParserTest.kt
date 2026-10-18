package com.sportzfy.live.data.config

import com.sportzfy.live.core.network.NetworkJson
import com.sportzfy.live.domain.model.Announcement
import com.sportzfy.live.domain.model.AppConfig
import com.sportzfy.live.domain.model.PlayerMode
import com.sportzfy.live.domain.model.SportCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AppConfigParserTest {

    private fun parse(raw: String) = AppConfigParser.parse(NetworkJson, raw)

    @Test
    fun `the shipped remote-config json parses to the defaults`() {
        // Unit tests run with the module directory as working directory.
        val shipped = File("../remote-config.json").readText()
        assertEquals(AppConfig.Default, parse(shipped))
    }

    @Test
    fun `parses every field`() {
        val config = parse(
            """{
              "announcement": {"message": " Final tonight! ", "url": "https://t.me/sportzfy"},
              "featuredMatchId": "match-1",
              "hiddenCategories": ["fight", "Motor-Sports", "nope"],
              "adBlocking": false,
              "extraBlockedHosts": ["*.Bad-Ads.com.", "evil.net", "has space.com", "a/b"],
              "playerMode": "iframe",
              "embedSandbox": false,
              "embedResolve": false,
              "minVersionCode": 3,
              "updateUrl": "https://github.com/svimran46/Sportzfylive-V2/releases",
              "maintenance": {"enabled": true, "message": "Back at 9pm"}
            }"""
        )!!
        assertEquals(Announcement("Final tonight!", "https://t.me/sportzfy"), config.announcement)
        assertEquals("match-1", config.featuredMatchId)
        assertEquals(setOf(SportCategory.FIGHT, SportCategory.MOTORSPORT), config.hiddenCategories)
        assertFalse(config.adBlocking)
        assertEquals(setOf("bad-ads.com", "evil.net"), config.extraBlockedHosts)
        assertEquals(PlayerMode.IFRAME, config.playerMode)
        assertFalse(config.embedSandbox)
        assertFalse(config.embedResolve)
        assertEquals("Back at 9pm", config.maintenanceMessage)
        assertTrue(config.requiresUpdate(2))
        assertFalse(config.requiresUpdate(3))
    }

    @Test
    fun `empty values mean off`() {
        val config = parse("""{"announcement":{"message":"  "},"featuredMatchId":"","maintenance":{"enabled":false,"message":"x"}}""")!!
        assertNull(config.announcement)
        assertNull(config.featuredMatchId)
        assertNull(config.maintenanceMessage)
        assertEquals(PlayerMode.DIRECT, config.playerMode)
    }

    @Test
    fun `maintenance without a message gets a default one`() {
        assertTrue(parse("""{"maintenance":{"enabled":true}}""")!!.maintenanceMessage!!.isNotBlank())
    }

    @Test
    fun `links must be https`() {
        val config = parse("""{"announcement":{"message":"hi","url":"http://x.com"},"updateUrl":"javascript:alert(1)"}""")!!
        assertNull(config.announcement?.linkUrl)
        assertNull(config.updateUrl)
    }

    @Test
    fun `the channel directory URL can be moved, but only to https`() {
        assertEquals("https://example.com/tv.json", parse("""{"channelsUrl":" https://example.com/tv.json "}""")!!.channelsUrl)
        assertEquals(AppConfig.DEFAULT_CHANNELS_URL, parse("""{"channelsUrl":"http://example.com/tv.json"}""")!!.channelsUrl)
        assertEquals(AppConfig.DEFAULT_CHANNELS_URL, parse("""{"channelsUrl":""}""")!!.channelsUrl)
    }

    @Test
    fun `the stream proxy defaults to the website's Worker and can be turned off`() {
        assertEquals(AppConfig.DEFAULT_STREAM_PROXY_URL, parse("{}")!!.streamProxyUrl)
        assertEquals(null, parse("""{"streamProxyUrl":""}""")!!.streamProxyUrl)
        assertEquals("https://proxy.example", parse("""{"streamProxyUrl":"https://proxy.example"}""")!!.streamProxyUrl)
        assertEquals(AppConfig.DEFAULT_STREAM_PROXY_URL, parse("""{"streamProxyUrl":"http://insecure.example"}""")!!.streamProxyUrl)
    }

    @Test
    fun `embeds are sandboxed by default and only an explicit false turns it off`() {
        assertTrue(parse("{}")!!.embedSandbox)
        assertTrue(parse("""{"embedSandbox":true}""")!!.embedSandbox)
        assertFalse(parse("""{"embedSandbox":false}""")!!.embedSandbox)
    }

    @Test
    fun `match pages are resolved to the native player by default`() {
        assertTrue(parse("{}")!!.embedResolve)
        assertTrue(parse("""{"embedResolve":true}""")!!.embedResolve)
        assertFalse(parse("""{"embedResolve":false}""")!!.embedResolve)
    }

    @Test
    fun `invalid json is rejected`() {
        assertNull(parse("not json"))
        assertNull(parse("[1,2]"))
    }
}
