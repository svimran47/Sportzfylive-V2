package com.sportzfy.live.core.player

import com.sportzfy.live.domain.model.StreamFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmbedManifestTest {

    @Test
    fun `recognises the embed host and nothing that merely looks like it`() {
        assertTrue(EmbedManifest.isEmbedPlayer("https://embed.st/embed/admin/ppv-bills-at-raiders/1"))
        assertTrue(EmbedManifest.isEmbedPlayer("https://embed.st:443/embed/a/b/2"))
        assertFalse(EmbedManifest.isEmbedPlayer("https://streamed.pk/watch/x"))
        assertFalse(EmbedManifest.isEmbedPlayer("https://notembed.st.evil.com/embed/a/b/1"))
        assertFalse(EmbedManifest.isEmbedPlayer("embed.st/embed/a/b/1"))
    }

    @Test
    fun `reads a manifest request but never a segment`() {
        assertEquals(StreamFormat.HLS, EmbedManifest.formatOf("https://strmd.b-cdn.net/live/abc/index.m3u8"))
        assertEquals(StreamFormat.HLS, EmbedManifest.formatOf("https://strmd.b-cdn.net/hls/abc/master.m3u8?token=1"))
        assertEquals(StreamFormat.HLS, EmbedManifest.formatOf("https://cdn.example/play?format=m3u8"))
        assertEquals(StreamFormat.DASH, EmbedManifest.formatOf("https://cdn.example/live/manifest.mpd"))
        assertNull(EmbedManifest.formatOf("https://strmd.b-cdn.net/live/abc/seg-1.ts"))
        assertNull(EmbedManifest.formatOf("https://cdn.example/poster.jpg"))
        assertNull(EmbedManifest.formatOf("https://embed.st/embed/a/b/1"))
    }

    @Test
    fun `resolves a manifest with the headers the page used, and only those`() {
        val stream = EmbedManifest.resolve(
            "https://strmd.b-cdn.net/live/abc/index.m3u8",
            mapOf(
                "Referer" to "https://embed.st/",
                "Cookie" to "session=1",
                "Accept" to "*/*",
                "Sec-Fetch-Dest" to "empty",
            ),
        )!!
        assertEquals("https://strmd.b-cdn.net/live/abc/index.m3u8", stream.url)
        assertEquals(StreamFormat.HLS, stream.format)
        assertEquals(mapOf("Referer" to "https://embed.st/", "Cookie" to "session=1"), stream.headers)
        assertNull(EmbedManifest.resolve("https://strmd.b-cdn.net/live/abc/seg-1.ts", emptyMap()))
    }
}
