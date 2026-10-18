package com.sportzfy.live.core.player

import com.sportzfy.live.core.player.PlayerUrlPolicy.Decision.ALLOW
import com.sportzfy.live.core.player.PlayerUrlPolicy.Decision.BLOCK
import org.junit.Assert.assertEquals
import org.junit.Test

class PlayerUrlPolicyTest {

    private val policy = PlayerUrlPolicy(streamUrl = "https://www.player.example/live/1")

    private fun main(url: String, redirect: Boolean = false, pageHost: String? = null, landing: Boolean = false) =
        policy.navigation(url, isMainFrame = true, isRedirect = redirect, pageHost = pageHost, landing = landing)
    private fun sub(url: String) = policy.navigation(url, isMainFrame = false)

    @Test
    fun `main frame stays on the active stream's host`() {
        assertEquals(ALLOW, main("https://www.player.example/live/2"))
        assertEquals(ALLOW, main("https://player.example/live/2"))
        assertEquals(ALLOW, main("https://cdn.player.example/x"))
        assertEquals(ALLOW, main("HTTPS://PLAYER.EXAMPLE./live"))
        assertEquals(ALLOW, main("http://player.example:8080/live"))
    }

    @Test
    fun `main frame may stay on embed st for every stream`() {
        assertEquals(ALLOW, main("https://embed.st/embed/alpha/match-101/1"))
        assertEquals(ALLOW, main("https://cdn.embed.st/x"))
    }

    @Test
    fun `the host is taken from whichever stream is playing`() {
        val channel = PlayerUrlPolicy(streamUrl = "http://tv.channel.test:8000/live")
        assertEquals(ALLOW, channel.navigation("http://tv.channel.test:8000/live?t=2", isMainFrame = true))
        assertEquals(BLOCK, channel.navigation("https://www.player.example/live/1", isMainFrame = true))
        // No stream yet: only the trusted hosts.
        assertEquals(BLOCK, PlayerUrlPolicy().navigation("https://player.example/x", isMainFrame = true))
    }

    @Test
    fun `external top-level redirects and lookalike hosts are cancelled`() {
        assertEquals(BLOCK, main("https://bet-now.example/promo"))
        assertEquals(BLOCK, main("https://player.example.evil.com/x"))
        assertEquals(BLOCK, main("https://evilplayer.example/x"))
        assertEquals(BLOCK, main("https://player.example@evil.com/x"))
        assertEquals(BLOCK, main("https://evil.com\\@player.example/x"))
        assertEquals(BLOCK, main("https://evil.com?player.example"))
        // A server redirect after the page has settled is still an ad redirect.
        assertEquals(BLOCK, main("https://bet-now.example/promo", redirect = true))
    }

    @Test
    fun `the first load may follow the stream server's redirects and stay where it lands`() {
        assertEquals(ALLOW, main("https://mirror.test/live/1", redirect = true, landing = true))
        assertEquals(ALLOW, main("https://mirror.test/live/1?retry=1", pageHost = "mirror.test"))
        // Script navigations during the first load are not server redirects.
        assertEquals(BLOCK, main("https://bet-now.example/promo", landing = true))
        // Ad networks stay blocked even then.
        assertEquals(BLOCK, main("https://ads.popads.net/r", redirect = true, landing = true))
    }

    @Test
    fun `app links and other schemes never load at the top level`() {
        for (url in listOf(
            "intent://scan/#Intent;scheme=market;end",
            "market://details?id=com.casino",
            "tel:123",
            "mailto:a@b.c",
            "javascript:alert(1)",
            "file:///sdcard/x",
            "content://x/y",
            "about:settings",
            "no-scheme",
            "",
        )) {
            assertEquals(url, BLOCK, main(url))
        }
        assertEquals(BLOCK, main("data:text/html,<script>"))
    }

    @Test
    fun `blank frames are allowed`() {
        assertEquals(ALLOW, main("about:blank"))
        assertEquals(ALLOW, sub("about:srcdoc"))
    }

    @Test
    fun `nested player iframes load from any host or scheme`() {
        for (url in listOf(
            "https://other-player.example/embed/1",
            "http://iptv.example:8080/embed/1",
            "blob:https://player.example/1234",
            "about:srcdoc",
            "intent://scan/#Intent;scheme=market;end",
        )) {
            assertEquals(url, ALLOW, sub(url))
        }
    }

    @Test
    fun `an ad network's iframe is the ad itself, so it is refused`() {
        for (url in listOf(
            "https://googleads.g.doubleclick.net/pagead",
            "https://www.propellerads.com/x",
            "https://a.exosrv.com/frame",
        )) {
            assertEquals(url, BLOCK, sub(url))
        }
    }

    @Test
    fun `scripts are not blocked by default, even from ad networks`() {
        // Inline player setup calls into these; refusing them leaves the player black.
        assertEquals(ALLOW, policy.resource("https://acscdn.com/script/aclib.js"))
        assertEquals(ALLOW, policy.resource("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"))
        assertEquals(ALLOW, policy.resource("https://cdn.example/hls/master.m3u8"))
        assertEquals(ALLOW, policy.resource("data:image/png;base64,AAAA"))
        // The ad's own frame, though, is the ad.
        assertEquals(BLOCK, policy.resource("https://googleads.g.doubleclick.net/pagead/ads", destination = "iframe"))
    }

    @Test
    fun `a script from a blocked host still loads, a frame or image does not`() {
        val ads = PlayerUrlPolicy(blockedResourceHosts = setOf("ads.test"))
        // Sec-Fetch-Dest decides when the WebView reports it.
        assertEquals(ALLOW, ads.resource("https://ads.test/x", destination = "script"))
        assertEquals(BLOCK, ads.resource("https://ads.test/x", destination = "iframe"))
        assertEquals(BLOCK, ads.resource("https://ads.test/x", destination = "image"))
        assertEquals(BLOCK, ads.resource("https://ads.test/beacon", destination = "empty"))
        // No destination (an older WebView): the URL and Accept header decide.
        assertEquals(ALLOW, ads.resource("https://ads.test/aclib.js"))
        assertEquals(ALLOW, ads.resource("https://ads.test/x", accept = "application/javascript"))
        assertEquals(BLOCK, ads.resource("https://ads.test/x", accept = "text/html"))
        assertEquals(BLOCK, ads.resource("https://ads.test/x", accept = "image/webp"))
        // Ambiguous requests are left alone rather than risk a black player.
        assertEquals(ALLOW, ads.resource("https://ads.test/x"))
    }

    @Test
    fun `resource blocking covers only the hosts it is given`() {
        val narrow = PlayerUrlPolicy(blockedHosts = AdHosts.DEFAULT, blockedResourceHosts = setOf("bad.test"))
        // A blocked host's script is still not a resource to refuse.
        assertEquals(ALLOW, narrow.resource("https://a.exosrv.com/ad-provider.js"))
        assertEquals(ALLOW, narrow.resource("https://a.exosrv.com/ad.png", destination = "image"))
        // Only the hosts given for resources are refused, and only when not a script.
        assertEquals(BLOCK, narrow.resource("https://x.bad.test/a.png", destination = "image"))
        assertEquals(ALLOW, narrow.resource("https://x.bad.test/a.js"))
        assertEquals(BLOCK, narrow.navigation("https://ads.popads.net/r", isMainFrame = true))
        assertEquals(ALLOW, narrow.navigation("https://nested.example/frame", isMainFrame = false))
    }

    @Test
    fun `trusted and blocked hosts are configurable`() {
        val custom = PlayerUrlPolicy(trustedHosts = setOf("player.test"), blockedHosts = setOf("bad.test"), blockedResourceHosts = setOf("bad.test"))
        assertEquals(ALLOW, custom.navigation("https://player.test/x", isMainFrame = true))
        assertEquals(BLOCK, custom.navigation("https://embed.st/x", isMainFrame = true))
        assertEquals(BLOCK, custom.navigation("https://bad.test/x", isMainFrame = true))
        assertEquals(BLOCK, custom.resource("https://x.bad.test/a.png", destination = "image"))
        assertEquals(ALLOW, custom.resource("https://x.bad.test/a.js"))
    }
}
