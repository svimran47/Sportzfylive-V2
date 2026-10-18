package com.sportzfy.live.core.player

/**
 * Hosts an embed inside a plain iframe, matching the website's player: no
 * `sandbox` attribute by default, full autoplay/fullscreen permissions and no
 * referrer. The app still owns the top-level page, so pop-ups and
 * `top.location` hijacks are refused by the WebView instead.
 *
 * [html] can add the website's own sandbox ([SANDBOX]) instead. Embeds check
 * for it and refuse to play ("Remove sandbox from iframe tab or add
 * allow-popups"), but the check only fails when the pop-up they open comes
 * back `null`. The pop-up shim keeps `window.open` from ever answering
 * `null`, so the check passes; the sandbox then drops pop-ups, top-level
 * navigation, downloads and pointer lock while keeping scripts, same-origin,
 * forms and dialogs, so the player runs and its session cookies still renew.
 */
object EmbedFrame {
    /** Origin the wrapper page runs under; mirrors the official embedding site. */
    const val BASE_URL = "https://streamed.pk/"

    /**
     * Origin of the wrapper for a sandboxed embed. No site lives on this host,
     * so the framed page is never same-origin with the wrapper and cannot
     * reach its frame element to drop the sandbox.
     */
    const val SANDBOX_BASE_URL = "https://sandbox.sportzfy.invalid/"

    /**
     * Sandbox for a framed embed. Scripts, same-origin, forms, dialogs and
     * presentation are allowed so the player runs and its session cookies keep
     * renewing; pop-ups, top-level navigation, downloads and pointer lock are
     * not. Pop-ups are trapped natively anyway (see the pop-up shim).
     */
    const val SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-presentation"

    /** [sandbox] adds the iframe's `sandbox` attribute; null (the default) leaves it off. */
    fun html(embedUrl: String, sandbox: String? = null): String =
        """<!doctype html><html><head><meta charset="utf-8">""" +
            """<meta name="viewport" content="width=device-width,initial-scale=1">""" +
            """<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}""" +
            """iframe{display:block;border:0;width:100%;height:100%}</style></head><body>""" +
            """<iframe src="${escapeAttribute(embedUrl)}" """ +
            (sandbox?.let { """sandbox="${escapeAttribute(it)}" """ }.orEmpty()) +
            """allow="autoplay; fullscreen; encrypted-media; picture-in-picture" """ +
            """allowfullscreen referrerpolicy="no-referrer"></iframe></body></html>"""

    private fun escapeAttribute(value: String): String =
        value.replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
}
