package com.sportzfy.live.presentation.watch.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.sportzfy.live.core.player.ChromeUserAgent
import com.sportzfy.live.core.player.PlayerUrlPolicy
import com.sportzfy.live.core.player.PopupShim
import java.io.ByteArrayInputStream

/** Callbacks from the player WebView, delivered on the main thread. */
internal interface SandboxListener {
    fun onNavigationBlocked(url: String)
    fun onPageStarted()
    fun onPageFinished()
    fun onMainFrameError()
    fun onRendererGone()
    fun onEnterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback)
    fun onExitFullscreen()
}

/**
 * Where the player's top-level page is, for [PlayerUrlPolicy]'s main-frame
 * rule. Read and written on the main thread only.
 */
internal class PageLanding {
    /** True from a direct load until its page starts, while server redirects are still followed. */
    var landing: Boolean = false
        private set

    /** Host the last direct load landed on; null for the iframe wrapper. */
    var host: String? = null
        private set

    /** A direct load of the stream page is starting. */
    fun begin() {
        landing = true
        host = null
    }

    /** The iframe wrapper is loading: its base URL is not a page the stream may return to. */
    fun clear() {
        landing = false
        host = null
    }

    fun onPageStarted(url: String?) {
        if (!landing) return
        landing = false
        host = url?.let { runCatching { Uri.parse(it).host }.getOrNull() }
    }
}

/**
 * Creates the player WebView for any stream page or embed URL. It presents
 * as Chrome with no sandbox, so the embed's anti-sandbox checks pass and its
 * own heartbeat scripts keep renewing the stream's session cookies and
 * tokens, while the app keeps the ads out:
 * - pop-up windows are trapped and destroyed without ever being shown;
 * - the top-level page stays on the stream's host ([PlayerUrlPolicy]); ad
 *   redirects and app links are cancelled, while nested player iframes load
 *   freely;
 * - the page's own scripts (ad scripts included) are never blocked, because
 *   inline player setup code calls into them; from the hosts the policy
 *   blocks, ad frames, images, beacons and XHR get an empty response instead;
 * - one document-start script ([PopupShim]) keeps `window.open` from ever
 *   answering `null`, which embed.st's player reads as a sandbox; a real
 *   window still comes from the native call and is trapped as above;
 * - no file or content access, downloads, geolocation or permission grants.
 *
 * [policy] is read on every request, so a new stream or remote config change
 * applies to a live player without rebuilding it. [onResource] sees every
 * request just before the policy does, which the embed resolver uses to spot
 * the media manifest (see [EmbedManifest]).
 */
@SuppressLint("SetJavaScriptEnabled")
internal fun createSandboxedWebView(
    context: Context,
    policy: () -> PlayerUrlPolicy,
    landing: PageLanding,
    listener: SandboxListener,
    onResource: ((WebResourceRequest) -> Unit)? = null,
): WebView = WebView(context).apply {
    settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false
        // Multiple windows stay "supported" so window.open reaches
        // onCreateWindow, which traps the ad. With support turned off,
        // WebView would load the pop-up over the stream instead.
        setSupportMultipleWindows(true)
        // As in a browser, so pages that test window.open still play.
        javaScriptCanOpenWindowsAutomatically = true
        allowFileAccess = false
        allowContentAccess = false
        // Embeds on https pages pull http playlists and segments; refusing them leaves a black player.
        mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        setGeolocationEnabled(false)
        setSupportZoom(false)
        builtInZoomControls = false
        displayZoomControls = false
        useWideViewPort = true
        loadWithOverviewMode = true
        // Stream sites refuse in-app WebViews; present exactly as Chrome.
        userAgentString = ChromeUserAgent.from(userAgentString.orEmpty())
    }
    presentAsChrome(settings)
    installPopupShim(this)
    // Embedded players sit in cross-site iframes and need their own cookies
    // for anti-bot checks and for the session the stream's playlist is tied to.
    val webView = this
    CookieManager.getInstance().apply {
        setAcceptCookie(true)
        setAcceptThirdPartyCookies(webView, true)
    }

    setBackgroundColor(Color.BLACK)
    keepScreenOn = true
    isLongClickable = false
    setOnLongClickListener { true }
    isHapticFeedbackEnabled = false
    setDownloadListener { _, _, _, _, _ -> }
    // D-pad: the page keeps left/right/center for its own controls, but
    // up/down always leave the player so a TV remote can reach the stream
    // pills and the back button instead of getting trapped in the page.
    setOnKeyListener { view, keyCode, event ->
        val direction = when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> View.FOCUS_UP
            KeyEvent.KEYCODE_DPAD_DOWN -> View.FOCUS_DOWN
            else -> return@setOnKeyListener false
        }
        if (event.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener true
        val next = view.focusSearch(direction)
        next != null && next !== view && next.requestFocus(direction)
    }

    webViewClient = SandboxedWebViewClient(policy, landing, listener, onResource)
    webChromeClient = SandboxedChromeClient(listener)
}

/**
 * Hides the WebView signals a page can read besides the user agent string:
 * the "Android WebView" brand in `navigator.userAgentData` (and the matching
 * Sec-CH-UA headers), and the X-Requested-With header carrying the app id.
 * Each needs a recent WebView; older ones keep their defaults.
 */
private fun presentAsChrome(settings: WebSettings) {
    // Best effort: a missing or unusual WebView provider must not stop playback.
    runCatching {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            val current = WebSettingsCompat.getUserAgentMetadata(settings)
            val brands = current.brandVersionList.map { brand ->
                if (brand.brand != ChromeUserAgent.WEBVIEW_BRAND) {
                    brand
                } else {
                    UserAgentMetadata.BrandVersion.Builder()
                        .setBrand(ChromeUserAgent.CHROME_BRAND)
                        .setMajorVersion(brand.majorVersion)
                        .setFullVersion(brand.fullVersion)
                        .build()
                }
            }
            WebSettingsCompat.setUserAgentMetadata(
                settings,
                UserAgentMetadata.Builder(current).setBrandVersionList(brands).build(),
            )
        }
    }
    runCatching {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet())
        }
    }
}

/**
 * Registers [PopupShim] for every frame of every page this WebView loads.
 * Needs a WebView with document-start scripts; older ones play without it.
 */
private fun installPopupShim(webView: WebView) {
    // Best effort, like presentAsChrome: a missing feature must not stop playback.
    runCatching {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, PopupShim.SCRIPT, PopupShim.ALLOWED_ORIGINS)
        }
    }
}

/**
 * Releases the renderer and media decoders. After the renderer has died the
 * WebView only accepts [WebView.destroy]; any other call can crash the app.
 */
internal fun WebView.release(rendererGone: Boolean) {
    if (!rendererGone) {
        stopLoading()
        removeAllViews()
    }
    destroy()
}

private class SandboxedWebViewClient(
    private val policy: () -> PlayerUrlPolicy,
    private val landing: PageLanding,
    private val listener: SandboxListener,
    private val onResource: ((WebResourceRequest) -> Unit)? = null,
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        val decision = policy().navigation(
            url,
            isMainFrame = request.isForMainFrame,
            isRedirect = request.isRedirect,
            pageHost = landing.host,
            landing = landing.landing,
        )
        if (decision == PlayerUrlPolicy.Decision.ALLOW) return false
        listener.onNavigationBlocked(url)
        return true
    }

    // Runs on a WebView background thread; must not touch UI state.
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        onResource?.invoke(request)
        val decision = policy().resource(
            request.url.toString(),
            destination = request.header("Sec-Fetch-Dest"),
            accept = request.header("Accept"),
        )
        return if (decision == PlayerUrlPolicy.Decision.BLOCK) emptySuccess(request) else null
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        landing.onPageStarted(url)
        listener.onPageStarted()
    }

    override fun onPageFinished(view: WebView, url: String?) {
        listener.onPageFinished()
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) listener.onMainFrameError()
    }

    // Without this override a crashed or killed renderer takes the app down.
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        listener.onRendererGone()
        return true
    }
}

private class SandboxedChromeClient(
    private val listener: SandboxListener,
) : WebChromeClient() {

    /**
     * Pop-ups (window.open, target=_blank) are how the stream sites show
     * their ads. Each one is handed a throwaway WebView that is never shown
     * and refuses every load, then destroyed: window.open still returns a
     * window, so pages that test for a pop-up blocker keep playing, but the
     * ad never renders, runs or leaves the app.
     */
    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        val popup = runCatching { WebView(view.context) }.getOrNull() ?: return false
        popup.settings.javaScriptEnabled = false
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean = true

            override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse =
                emptySuccess(request)

            override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean = true
        }
        transport.webView = popup
        resultMsg.sendToTarget()
        listener.onNavigationBlocked("popup")
        // Not attached to any window, so View.post would never run: use the main looper.
        Handler(Looper.getMainLooper()).postDelayed({ popup.destroy() }, POPUP_LIFETIME_MS)
        return true
    }

    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        listener.onEnterFullscreen(view, callback)
    }

    override fun onHideCustomView() {
        listener.onExitFullscreen()
    }

    // alert/confirm/prompt keep WebView's default dialogs, as in a browser:
    // some sites gate the stream behind one.

    override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
        result.confirm()
        return true
    }

    override fun onPermissionRequest(request: PermissionRequest) {
        request.deny()
    }

    // Replaces the grey placeholder WebView draws before a <video> starts.
    override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
}

/** How long a trapped pop-up's window stays open to its opener before it is destroyed. */
private const val POPUP_LIFETIME_MS = 1_500L

/** A request header by name, whatever case the WebView used for the key. */
internal fun WebResourceRequest.header(name: String): String? =
    requestHeaders.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

/**
 * Answer for a refused request: an empty 200 rather than a network error, so
 * a script tag's onload and a fetch() both succeed and the embed's "did the
 * ad load" checks pass. CORS is opened for the same reason.
 */
private fun emptySuccess(request: WebResourceRequest): WebResourceResponse {
    val accept = request.header("Accept").orEmpty()
    val path = request.url.path.orEmpty()
    val mime = when {
        path.endsWith(".js") || "javascript" in accept -> "application/javascript"
        path.endsWith(".css") || "text/css" in accept -> "text/css"
        else -> "text/plain"
    }
    return WebResourceResponse(
        mime,
        "utf-8",
        200,
        "OK",
        mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0)),
    )
}
