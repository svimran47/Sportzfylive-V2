package com.sportzfy.live.presentation.watch.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.sportzfy.live.core.player.EmbedManifest
import com.sportzfy.live.core.player.PlaybackSource
import com.sportzfy.live.core.player.PlayerConfig
import com.sportzfy.live.core.player.ResolvedStream
import com.sportzfy.live.domain.model.StreamFormat
import com.sportzfy.live.presentation.components.tvFocus

/**
 * Dual-engine player: Media3 for media streams (HLS, DASH, MPEG-TS, MP4…),
 * the player WebView for web pages (the `embed.st` players, channel
 * sites). [format] (a channel's `type`) overrides the guess from the URL's
 * extension. Fills [modifier]; the caller decides the aspect ratio.
 * [textureSurface]: see [MediaPlayerView]. [drmLicenseUrl]: see
 * [MediaPlayerView] — a ClearKey DASH channel's license route.
 *
 * An `embed.st` page ([EmbedManifest.isEmbedPlayer]) is first resolved in a
 * hidden WebView — see [EmbedResolverHost] — so its real stream plays in
 * Media3; only a page the resolver can't work out stays in the WebView.
 */
@Composable
fun StreamPlayer(
    url: String?,
    modifier: Modifier = Modifier,
    state: StreamPlayerState = rememberStreamPlayerState(),
    config: PlayerConfig = PlayerConfig(),
    format: StreamFormat? = null,
    textureSurface: Boolean = false,
    drmLicenseUrl: String? = null,
) {
    val source = remember(url, format, config.allowHttpStreams, config.extendedFormats) {
        url?.let { PlaybackSource.from(it, format, config.allowHttpStreams, config.extendedFormats) }
    }
    val embedUrl = (source as? PlaybackSource.Embed)?.url
    val resolvable = embedUrl != null && config.resolveEmbeds && EmbedManifest.isEmbedPlayer(embedUrl)

    // The current attempt's outcome; a retry (new reloadToken) re-arms it.
    var resolved by remember(embedUrl, state.reloadToken) { mutableStateOf<ResolvedStream?>(null) }
    var unresolved by remember(embedUrl, state.reloadToken) { mutableStateOf(false) }
    val stream = resolved

    LaunchedEffect(source, state.reloadToken) {
        if (source != null) state.onSourceChanged()
    }

    Box(modifier = modifier.background(Color.Black)) {
        when {
            source is PlaybackSource.Media ->
                MediaPlayerView(source.url, source.format, state, Modifier.fillMaxSize(), textureSurface, drmLicenseUrl = drmLicenseUrl)

            stream != null ->
                MediaPlayerView(stream.url, stream.format, state, Modifier.fillMaxSize(), textureSurface, stream.headers)

            resolvable && !unresolved ->
                EmbedResolverHost(
                    url = embedUrl!!,
                    reloadToken = state.reloadToken,
                    config = config,
                    state = state,
                    onResolved = { resolved = it },
                    onUnresolved = { unresolved = true },
                )

            source is PlaybackSource.Embed ->
                EmbedPlayerView(source.url, state, Modifier.fillMaxSize(), config)

            else -> PlayerMessage(
                text = if (url == null) "Pick a stream to start watching" else unplayableMessage(url, format, config),
                modifier = Modifier.align(Alignment.Center),
            )
        }

        val error = state.error
        when {
            error != null -> PlayerMessage(
                text = error.message,
                modifier = Modifier.align(Alignment.Center),
                actionLabel = if (error in PERMANENT_ERRORS) null else "Retry",
                onAction = state::retry,
            )
            source != null && state.isLoading -> CircularProgressIndicator(
                modifier = Modifier.align(Alignment.Center),
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/** Errors a retry can't fix, so no Retry button is offered. */
private val PERMANENT_ERRORS = setOf(PlayerError.WEBVIEW_UNAVAILABLE, PlayerError.UNSUPPORTED_FORMAT, PlayerError.DRM_PROTECTED)

private val PlayerError.message: String
    get() = when (this) {
        PlayerError.LOAD_FAILED -> "Couldn't load this stream. Try another one."
        PlayerError.PLAYBACK_FAILED -> "Playback stopped. The feed may be offline."
        PlayerError.WEBVIEW_UNAVAILABLE -> "This device has no web player. Install or update Android System WebView."
        PlayerError.UNSUPPORTED_FORMAT -> "This device can't play this stream's format. Try another one."
        PlayerError.DRM_PROTECTED -> "This stream is copy-protected (DRM) and can't play in the app."
    }

/** Why [url] got no engine, when the reason is a switch the owner turned off. */
private fun unplayableMessage(url: String, format: StreamFormat?, config: PlayerConfig): String {
    val trimmed = url.trim()
    return when {
        !config.allowHttpStreams && trimmed.startsWith("http://", ignoreCase = true) ->
            "Plain-HTTP streams are turned off right now."
        !config.extendedFormats && (format ?: StreamFormat.fromUrl(trimmed)).let { it == StreamFormat.DASH || it == StreamFormat.PROGRESSIVE } ->
            "This stream's format is turned off right now."
        else -> "This stream can't be played"
    }
}

@Composable
private fun PlayerMessage(
    text: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White.copy(alpha = 0.85f),
            textAlign = TextAlign.Center,
        )
        if (actionLabel != null) {
            TextButton(onClick = onAction, modifier = Modifier.tvFocus(RoundedCornerShape(50))) { Text(actionLabel) }
        }
    }
}
