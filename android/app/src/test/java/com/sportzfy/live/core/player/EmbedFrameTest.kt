package com.sportzfy.live.core.player

import com.sportzfy.live.core.player.PlayerUrlPolicy.Decision.ALLOW
import com.sportzfy.live.core.player.PlayerUrlPolicy.Decision.BLOCK
import com.sportzfy.live.domain.model.AppConfig
import com.sportzfy.live.domain.model.PlayerMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EmbedFrameTest {

    @Test
    fun `wraps the embed in an unsandboxed iframe`() {
        val html = EmbedFrame.html("https://embed.st/embed/alpha/match-101/1")
        assertTrue(html.contains("""<iframe src="https://embed.st/embed/alpha/match-101/1" """))
        assertTrue(html.contains("allowfullscreen"))
        assertTrue(html.contains("autoplay"))
        assertFalse(html.contains("sandbox"))
    }

    @Test
    fun `escapes the url attribute`() {
        val html = EmbedFrame.html("""https://embed.st/a"><script>x</script>&b""")
        assertTrue(html.contains("""src="https://embed.st/a&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;b""""))
        assertFalse(html.contains("<script>"))
    }

    @Test
    fun `sandboxed wrapper carries the sandbox attribute`() {
        val html = EmbedFrame.html("https://embed.st/embed/alpha/match-101/1", EmbedFrame.SANDBOX)
        assertTrue(
            html.contains(
                """<iframe src="https://embed.st/embed/alpha/match-101/1" """ +
                    """sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-presentation" """ +
                    """allow="autoplay; fullscreen; encrypted-media; picture-in-picture" """,
            ),
        )
        assertTrue(html.contains("allowfullscreen"))
        assertTrue(EmbedFrame.SANDBOX_BASE_URL.startsWith("https://"))
    }

    @Test
    fun `player config follows the remote config`() {
        // Embeds load directly with no referer, exactly like a browser tab,
        // but inside a sandboxed frame: the app ships with the sandbox on.
        // The pop-up networks are always kept off the top-level page and their
        // frames; the wider ad list only with ad blocking on.
        assertEquals(
            PlayerConfig(
                PlayerMode.DIRECT,
                blockedHosts = AdHosts.ALWAYS_BLOCKED,
                blockedResourceHosts = AdHosts.ALWAYS_BLOCKED,
                referer = null,
                sandboxed = true,
                resolveEmbeds = true,
            ),
            PlayerConfig.from(AppConfig.Default),
        )
        assertTrue(PlayerConfig.from(AppConfig(adBlocking = true)).blockedHosts.containsAll(AdHosts.DEFAULT))
        assertTrue(PlayerConfig.from(AppConfig(adBlocking = true)).blockedResourceHosts.containsAll(AdHosts.DEFAULT))
        val noAds = PlayerConfig.from(AppConfig(adBlocking = false, extraBlockedHosts = setOf("bad.com"), playerMode = PlayerMode.IFRAME))
        assertEquals(PlayerMode.IFRAME, noAds.mode)
        assertEquals(AdHosts.ALWAYS_BLOCKED + "bad.com", noAds.blockedHosts)
        assertEquals(noAds.blockedHosts, noAds.blockedResourceHosts)
        assertFalse(PlayerConfig.from(AppConfig(embedSandbox = false)).sandboxed)
        assertTrue(PlayerConfig.from(AppConfig(embedSandbox = true)).sandboxed)
        assertFalse(PlayerConfig.from(AppConfig(embedResolve = false)).resolveEmbeds)
        assertTrue(PlayerConfig.from(AppConfig(embedResolve = true)).resolveEmbeds)
        assertTrue(PlayerConfig.from(AppConfig(adBlocking = true, extraBlockedHosts = setOf("bad.com"))).blockedHosts.containsAll(AdHosts.DEFAULT + "bad.com"))
    }

    @Test
    fun `ad scripts load so inline player setup does not crash, ad frames and redirects stay blocked`() {
        val config = PlayerConfig.from(AppConfig(adBlocking = true, extraBlockedHosts = setOf("bad.com")))
        assertEquals(AdHosts.ALWAYS_BLOCKED + AdHosts.DEFAULT + "bad.com", config.blockedResourceHosts)
        val policy = PlayerUrlPolicy(
            streamUrl = "https://embed.st/embed/golf/x/1",
            blockedHosts = config.blockedHosts,
            blockedResourceHosts = config.blockedResourceHosts,
        )
        for (host in AdHosts.ALWAYS_BLOCKED) {
            assertEquals(host, ALLOW, policy.resource("https://$host/aclib.js"))
            assertEquals(host, BLOCK, policy.resource("https://$host/ad.png", destination = "image"))
            assertEquals(host, BLOCK, policy.navigation("https://$host/landing", isMainFrame = true))
            assertEquals(host, BLOCK, policy.navigation("https://$host/frame", isMainFrame = false))
        }
        assertEquals(BLOCK, policy.resource("https://x.bad.com/a.png", destination = "image"))
        assertEquals(ALLOW, policy.resource("https://x.bad.com/a.js"))
        assertEquals(ALLOW, policy.navigation("https://player.other-cdn.example/embed", isMainFrame = false))
    }
}
