package com.sportzfy.live.presentation.watch.player

import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sportzfy.live.core.player.EmbedFrame
import com.sportzfy.live.core.player.PlayerConfig
import com.sportzfy.live.core.player.PlayerUrlPolicy
import com.sportzfy.live.domain.model.EmbedUrl
import com.sportzfy.live.domain.model.PlayerMode

/**
 * Plays any stream page or embed URL. In [PlayerMode.DIRECT] (the default)
 * it is the WebView's page itself, like a browser tab; in [PlayerMode.IFRAME]
 * it runs in a plain, unsandboxed iframe inside a wrapper page, like the
 * website. When [PlayerConfig.sandboxed] is set it uses the iframe wrapper
 * with a `sandbox` attribute, so the frame itself refuses pop-ups, top-level
 * navigation and downloads. Either way the page stays on [url]'s host and
 * pop-ups are trapped (see [createSandboxedWebView]).
 *
 * The WebView is created once and reused: a new [url], mode, sandbox or
 * [StreamPlayerState.retry] reloads the same instance, so switching streams
 * never rebuilds the surrounding layout. A fresh WebView is created only
 * after its renderer process dies.
 */
@Composable
internal fun EmbedPlayerView(
    url: String,
    state: StreamPlayerState,
    modifier: Modifier = Modifier,
    config: PlayerConfig = PlayerConfig(),
) {
    val policy = remember(url, config.blockedHosts, config.blockedResourceHosts) {
        PlayerUrlPolicy(
            streamUrl = url,
            trustedHosts = setOf(EmbedUrl.HOST),
            blockedHosts = config.blockedHosts,
            blockedResourceHosts = config.blockedResourceHosts,
        )
    }
    val currentPolicy by rememberUpdatedState(policy)
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var generation by remember { mutableIntStateOf(0) }
    val holder = remember { WebViewHolder() }

    val activity = remember(context) { context.findActivity() }
    val fullscreen = remember(activity) {
        activity?.let { host -> FullscreenHost(host) { state.isFullscreen = it } }
    }

    val listener = remember(state, fullscreen) {
        object : SandboxListener {
            override fun onNavigationBlocked(url: String) {
                state.blockedCount++
            }

            override fun onPageStarted() {
                state.isLoading = true
            }

            override fun onPageFinished() {
                state.isLoading = false
            }

            override fun onMainFrameError() {
                state.isLoading = false
                state.error = PlayerError.LOAD_FAILED
            }

            override fun onRendererGone() {
                // The dead WebView is released by onRelease once the new one replaces it.
                fullscreen?.teardown()
                holder.deadWebView = holder.webView
                holder.webView = null
                generation++
            }

            override fun onEnterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
                if (fullscreen != null) fullscreen.enter(view, callback) else callback.onCustomViewHidden()
            }

            override fun onExitFullscreen() {
                fullscreen?.teardown()
            }
        }
    }

    BackHandler(enabled = state.isFullscreen) { fullscreen?.exit() }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> {
                    // Picture-in-picture pauses the activity but keeps it on
                    // screen: the stream plays on until the window is closed (ON_STOP).
                    if (activity?.isInPictureInPictureMode != true) holder.webView?.onPause()
                    // Keep the stream's renewed session cookies across process death.
                    CookieManager.getInstance().flush()
                }
                Lifecycle.Event.ON_STOP -> holder.webView?.onPause()
                Lifecycle.Event.ON_RESUME -> holder.webView?.onResume()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            // teardown, not exit: the WebView may already be destroyed.
            fullscreen?.teardown()
        }
    }

    key(generation) {
        AndroidView(
            modifier = modifier,
            factory = { ctx ->
                try {
                    createSandboxedWebView(ctx, { currentPolicy }, holder.landing, listener).also { holder.webView = it }
                } catch (e: Exception) {
                    // Thrown when the device has no (or a broken) WebView provider.
                    state.isLoading = false
                    state.error = PlayerError.WEBVIEW_UNAVAILABLE
                    FrameLayout(ctx)
                }
            },
            update = { view ->
                val webView = view as? WebView ?: return@AndroidView
                val request = LoadRequest(url, state.reloadToken, config.mode, config.sandboxed)
                if (webView.tag != request) {
                    webView.tag = request
                    if (config.sandboxed) {
                        holder.landing.clear()
                        webView.loadDataWithBaseURL(
                            EmbedFrame.SANDBOX_BASE_URL,
                            EmbedFrame.html(url, EmbedFrame.SANDBOX),
                            "text/html",
                            "utf-8",
                            null,
                        )
                    } else if (config.mode == PlayerMode.IFRAME) {
                        holder.landing.clear()
                        webView.loadDataWithBaseURL(EmbedFrame.BASE_URL, EmbedFrame.html(url), "text/html", "utf-8", null)
                    } else {
                        holder.landing.begin()
                        webView.loadUrl(url, config.referer?.let { mapOf("Referer" to it) } ?: emptyMap())
                    }
                }
            },
            onRelease = { view ->
                if (view is WebView) {
                    val rendererGone = holder.deadWebView === view
                    if (rendererGone) holder.deadWebView = null
                    if (holder.webView === view) holder.webView = null
                    view.release(rendererGone)
                }
            },
        )
    }
}

private class WebViewHolder {
    var webView: WebView? = null
    var deadWebView: WebView? = null
    val landing = PageLanding()
}

internal data class LoadRequest(val url: String, val reloadToken: Int, val mode: PlayerMode, val sandboxed: Boolean)
