package com.sportzfy.live.presentation.watch.player

import androidx.annotation.OptIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.drm.KeyRequest
import androidx.media3.exoplayer.drm.MediaDrmCallback
import androidx.media3.exoplayer.drm.ProvisionRequest
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.compose.PlayerSurface
import androidx.media3.ui.compose.SURFACE_TYPE_SURFACE_VIEW
import androidx.media3.ui.compose.SURFACE_TYPE_TEXTURE_VIEW
import androidx.media3.ui.compose.SURFACE_TYPE_TEXTURE_VIEW
import com.sportzfy.live.domain.model.StreamFormat
import java.util.UUID
import okhttp3.OkHttpClient
import okhttp3.Request
import org.koin.compose.koinInject

/**
 * Plays a media stream with Media3: HLS (`.m3u8`), DASH (`.mpd`) or a
 * progressive file/stream (MPEG-TS, MP4, Matroska/WebM, FLV, MP3, AAC), over
 * http or https. Everything is fetched through the app's OkHttp client, so
 * it carries the same browser headers as API calls.
 *
 * A live stream that falls behind its window (the device paused or stalled
 * past the oldest segment still listed) jumps back to the live edge on its
 * own instead of showing an error.
 *
 * [textureSurface] draws into a TextureView instead of a SurfaceView, so the
 * video can be clipped, moved and resized with the layout (the floating TV player).
 *
 * [requestHeaders] are replayed on the media request. A URL resolved out of an
 * embed page is often tied to the headers that page sent (a Referer or a
 * session cookie), so the same ones are sent again.
 *
 * [drmLicenseUrl] turns on ClearKey for a DASH stream: the device's ClearKey
 * CDM asks [drmLicenseUrl] for the channel's key pair (a standard license
 * response; the request body is ignored) and the manifest decrypts without a
 * license server. It is meant for the Worker's `/api/drm/tv/:id` route, which
 * only serves a key while the channel is active.
 */
@OptIn(UnstableApi::class)
@Composable
internal fun MediaPlayerView(
    url: String,
    format: StreamFormat,
    state: StreamPlayerState,
    modifier: Modifier = Modifier,
    textureSurface: Boolean = false,
    requestHeaders: Map<String, String> = emptyMap(),
    drmLicenseUrl: String? = null,
    okHttpClient: OkHttpClient = koinInject(),
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val player = remember {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(okHttpClient)))
            .build()
    }

    DisposableEffect(player) {
        val playerListener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                state.isLoading = playbackState == Player.STATE_BUFFERING || playbackState == Player.STATE_IDLE
                if (playbackState == Player.STATE_READY) state.error = null
            }

            override fun onPlayerError(error: PlaybackException) {
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                    player.seekToDefaultPosition()
                    player.prepare()
                    return
                }
                state.isLoading = false
                state.error = playerErrorFor(error.errorCode)
            }
        }
        player.addListener(playerListener)
        state.transport = PlaybackTransport { paused ->
            state.isPaused = paused
            if (paused) player.pause() else player.play()
        }
        onDispose {
            state.transport = null
            state.isPaused = false
            player.removeListener(playerListener)
            player.release()
        }
    }

    DisposableEffect(player, lifecycleOwner) {
        val lifecycleObserver = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> player.pause()
                // A stream the user paused stays paused when the app comes back.
                Lifecycle.Event.ON_START -> if (!state.isPaused) player.play()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(lifecycleObserver)
        onDispose { lifecycleOwner.lifecycle.removeObserver(lifecycleObserver) }
    }

    LaunchedEffect(player, url, format, state.reloadToken, requestHeaders, drmLicenseUrl) {
        val clearKey = drmLicenseUrl != null && format == StreamFormat.DASH
        val mediaItem = MediaItem.Builder()
            .setUri(url)
            .setMimeType(format.mimeType())
            .apply {
                if (clearKey) {
                    // Sessions for both tracks: the ClearKey CDM gets its keys
                    // from the license response, not from a PSSH handshake.
                    setDrmConfiguration(
                        MediaItem.DrmConfiguration.Builder(C.CLEARKEY_UUID)
                            .setForceSessionsForAudioAndVideoTracks(true)
                            .build()
                    )
                }
            }
            .build()
        // Built per item so a resolved stream's headers apply to it alone; the
        // player is reused across streams and must not keep the last ones.
        val dataSourceFactory = OkHttpDataSource.Factory(okHttpClient)
            .setDefaultRequestProperties(requestHeaders)
        val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
        if (clearKey) {
            mediaSourceFactory.setDrmSessionManagerProvider {
                clearKeySessionManager(drmLicenseUrl!!, okHttpClient)
            }
        }
        player.setMediaSource(mediaSourceFactory.createMediaSource(mediaItem))
        player.prepare()
        player.playWhenReady = true
    }

    LaunchedEffect(player, state.isMuted) {
        player.volume = if (state.isMuted) 0f else 1f
    }

    PlayerSurface(
        player = player,
        modifier = modifier,
        surfaceType = if (textureSurface) SURFACE_TYPE_TEXTURE_VIEW else SURFACE_TYPE_SURFACE_VIEW,
    )
}

/**
 * HLS and DASH are named outright, so a manifest URL without the usual
 * extension still plays. Progressive streams pass no type: Media3 sniffs the
 * container (TS, MP4, Matroska…) from the bytes.
 */
private fun StreamFormat.mimeType(): String? = when (this) {
    StreamFormat.HLS -> MimeTypes.APPLICATION_M3U8
    StreamFormat.DASH -> MimeTypes.APPLICATION_MPD
    StreamFormat.PROGRESSIVE, StreamFormat.EMBED -> null
}

/**
 * A ClearKey session manager whose license "server" is the Worker's
 * `/api/drm/tv/:id` route. The device's ClearKey CDM writes its request to
 * [licenseUrl], which answers with the W3C license response
 * (`{"keys":[{"kty":"oct",…}]}`); the request body carries nothing the route
 * needs to know, so a plain GET is enough. A non-200 answer fails the
 * session, which surfaces as a playback error — there is no key to play
 * without it.
 */
@OptIn(UnstableApi::class)
private fun clearKeySessionManager(licenseUrl: String, okHttpClient: OkHttpClient): DefaultDrmSessionManager =
    DefaultDrmSessionManager.Builder()
        .setUuidAndExoMediaDrmProvider(C.CLEARKEY_UUID, FrameworkMediaDrm.DEFAULT_PROVIDER)
        .build(
            object : MediaDrmCallback {
                override fun executeKeyRequest(uuid: UUID, request: KeyRequest): ByteArray =
                    okHttpClient.newCall(Request.Builder().url(licenseUrl).build()).execute().use { response ->
                        check(response.isSuccessful) { "ClearKey license request failed: ${response.code}" }
                        response.body.bytes()
                    }

                // ClearKey never provisions: provision requests don't happen.
                override fun executeProvisionRequest(uuid: UUID, request: ProvisionRequest): ByteArray = ByteArray(0)
            }
        )
