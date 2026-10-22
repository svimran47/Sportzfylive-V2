package com.sportzfy.live.presentation.watch.player

import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.sportzfy.live.core.player.EmbedManifest
import com.sportzfy.live.core.player.PlayerConfig
import com.sportzfy.live.core.player.PlayerUrlPolicy
import com.sportzfy.live.core.player.ResolvedStream
import com.sportzfy.live.domain.model.EmbedUrl
import kotlinx.coroutines.delay
import java.util.concurrent.atomic.AtomicBoolean

/** How long the hidden WebView is given to ask for the stream's manifest. */
internal const val EMBED_RESOLVE_TIMEOUT_MS = 8_000L

/**
 * Runs an `embed.st` page in a hidden, never-shown WebView just long enough for
 * its own JavaScript to request the stream's manifest, then hands that URL to
 * [onResolved] so Media3 can play it. Nothing renders; the caller shows its own
 * spinner. [onUnresolved] fires when the page fails to load or no manifest
 * appears within [EMBED_RESOLVE_TIMEOUT_MS], and the caller falls back to the
 * web player.
 *
 * The page resolves under the same policy as the visible player, from the same
 * trap-the-ads WebView: its pop-ups are destroyed and its ad requests refused,
 * so a manifest the resolver captures is the stream's, not an ad's.
 */
@Composable
internal fun EmbedResolverHost(
    url: String,
    reloadToken: Int,
    config: PlayerConfig,
    state: StreamPlayerState,
    onResolved: (ResolvedStream) -> Unit,
    onUnresolved: () -> Unit,
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
    val currentOnResolved by rememberUpdatedState(onResolved)
    val currentOnUnresolved by rememberUpdatedState(onUnresolved)

    // One outcome per attempt, and callbacks land on the main thread: the
    // manifest is seen on the WebView's own thread.
    val settled = remember(url, reloadToken) { AtomicBoolean(false) }
    val main = remember { Handler(Looper.getMainLooper()) }
    fun settle(action: () -> Unit) {
        if (settled.compareAndSet(false, true)) main.post(action)
    }

    key(url, reloadToken) {
        AndroidView(
            modifier = Modifier.size(1.dp).alpha(0f),
            factory = { context ->
                val listener = object : SandboxListener {
                    override fun onNavigationBlocked(url: String) {
                        state.blockedCount++
                    }

                    override fun onPageStarted() = Unit

                    override fun onPageFinished() = Unit

                    override fun onMainFrameError() = settle { currentOnUnresolved() }

                    override fun onRendererGone() = settle { currentOnUnresolved() }

                    override fun onEnterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
                        callback.onCustomViewHidden()
                    }

                    override fun onExitFullscreen() = Unit
                }
                createSandboxedWebView(context, { currentPolicy }, PageLanding(), listener) { request: WebResourceRequest ->
                    EmbedManifest.resolve(request.url.toString(), request.requestHeaders)?.let { stream ->
                        settle { currentOnResolved(stream) }
                    }
                }.also { webView ->
                    // Invisible and never focusable, so it can't take the D-pad
                    // from the stream list while it resolves.
                    webView.isFocusable = false
                    webView.isFocusableInTouchMode = false
                    webView.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    webView.loadUrl(url)
                }
            },
            onRelease = { view -> view.release(rendererGone = false) },
        )
    }

    LaunchedEffect(url, reloadToken) {
        delay(EMBED_RESOLVE_TIMEOUT_MS)
        settle { currentOnUnresolved() }
    }
}
