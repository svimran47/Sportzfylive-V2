package com.sportzfy.live.presentation.livetv.player

import android.content.pm.ActivityInfo
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateRectAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.toSize
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.util.Consumer
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.sportzfy.live.core.player.PictureInPictureHost
import com.sportzfy.live.core.player.PlayerConfig
import com.sportzfy.live.core.theme.SportzfyColors
import com.sportzfy.live.core.theme.SportzfyIcon
import com.sportzfy.live.core.theme.SportzfyIcons
import com.sportzfy.live.domain.model.Channel
import com.sportzfy.live.domain.model.PlayerMode
import com.sportzfy.live.presentation.components.LiveBadge
import com.sportzfy.live.presentation.components.tvFocus
import com.sportzfy.live.presentation.config.LocalAppConfig
import com.sportzfy.live.presentation.watch.player.StreamPlayer
import com.sportzfy.live.presentation.watch.player.StreamPlayerState
import com.sportzfy.live.presentation.watch.player.findActivity
import com.sportzfy.live.presentation.watch.player.rememberStreamPlayerState
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/** Window position of the docked player's slot on the Live TV tab; null while it isn't on screen. */
@Stable
class TvDockAnchor {
    var bounds by mutableStateOf<Rect?>(null)
        internal set
}

@Composable
fun rememberTvDockAnchor(): TvDockAnchor = remember { TvDockAnchor() }

/** Reserves the docked player's place on the page; [TvPlayerLayer] draws the player over it. */
@Composable
fun TvDockSlot(anchor: TvDockAnchor, modifier: Modifier = Modifier) {
    Box(
        modifier
            .background(Color.Black)
            .onGloballyPositioned { anchor.bounds = Rect(it.positionInWindow(), it.size.toSize()) }
    )
    DisposableEffect(anchor) { onDispose { anchor.bounds = null } }
}

/** Where the layer draws the player this frame. */
private enum class Placement { DOCKED, MINI, FULL }

/**
 * The one Live TV player, drawn above every screen so a channel never
 * restarts when it moves: over the [TvDockSlot] on the Live TV tab, as a
 * draggable floating window anywhere else (or when minimized), across the
 * whole screen in full screen and in system picture-in-picture.
 */
@Composable
fun TvPlayerLayer(
    viewModel: TvPlayerViewModel,
    anchor: TvDockAnchor,
    onOpenLiveTv: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val channel = state.channel
    val activity = LocalContext.current.findActivity()
    val pipHost = activity as? PictureInPictureHost
    val playing = channel != null

    DisposableEffect(pipHost, playing) {
        pipHost?.setPictureInPictureSource(playing)
        onDispose { pipHost?.setPictureInPictureSource(false) }
    }
    if (channel == null) return

    val inPip = rememberIsInPictureInPicture(activity as? ComponentActivity)
    val fullscreen = state.presentation == TvPresentation.FULLSCREEN && !inPip
    val dock = anchor.bounds
    val placement = when {
        inPip || fullscreen -> Placement.FULL
        state.presentation == TvPresentation.DOCKED && dock != null -> Placement.DOCKED
        else -> Placement.MINI
    }

    FullscreenWindowEffect(active = fullscreen)
    BackHandler(enabled = fullscreen) { viewModel.exitFullscreen() }

    val playerState = rememberStreamPlayerState()
    KeepScreenOnEffect(active = !playerState.isPaused)

    // Channel pages load directly with no referer, like the match player: the
    // page stays on its own host and its pop-ups are trapped. A channel the
    // directory flagged, or the remote sandbox switch, runs in a sandboxed
    // iframe instead.
    val baseConfig = PlayerConfig.from(LocalAppConfig.current)
    val config = baseConfig.copy(
        mode = PlayerMode.DIRECT,
        sandboxed = baseConfig.sandboxed || channel.sandboxed,
    )
    var origin by remember { mutableStateOf(Offset.Zero) }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .onGloballyPositioned { origin = it.positionInWindow() }
    ) {
        val density = LocalDensity.current
        val layerWidth = constraints.maxWidth.toFloat()
        val layerHeight = constraints.maxHeight.toFloat()
        val mini = rememberMiniWindow(maxWidth, layerWidth, layerHeight)

        val target = when (placement) {
            Placement.FULL -> Rect(0f, 0f, layerWidth, layerHeight)
            Placement.DOCKED -> dock!!.translate(-origin)
            Placement.MINI -> mini.bounds
        }
        // Docked ⇄ mini glides; full screen, PiP and dragging follow at once.
        val previous = remember { Holder(placement) }
        val glide = placement != Placement.FULL && previous.value != Placement.FULL && !mini.isDragging
        previous.value = placement
        val rect by animateRectAsState(
            targetValue = target,
            animationSpec = if (glide) tween(durationMillis = 260) else snap(),
            label = "tvPlayerBounds",
        )

        val shape = when (placement) {
            Placement.MINI -> RoundedCornerShape(14.dp)
            Placement.DOCKED, Placement.FULL -> RectangleShape
        }
        Box(
            modifier = Modifier
                .offset { IntOffset(rect.left.roundToInt(), rect.top.roundToInt()) }
                .size(with(density) { DpSize(rect.width.toDp(), rect.height.toDp()) })
                .then(if (placement == Placement.MINI) Modifier.shadow(16.dp, shape) else Modifier)
                .clip(shape)
                .background(Color.Black)
                .testTag("tv-player"),
        ) {
            StreamPlayer(
                url = channel.streamUrl,
                format = channel.streamFormat,
                modifier = Modifier.fillMaxSize(),
                state = playerState,
                config = config,
                textureSurface = true,
            )
            if (placement == Placement.MINI) {
                MiniControls(
                    playerState = playerState,
                    window = mini,
                    onExpand = {
                        viewModel.expand()
                        onOpenLiveTv()
                    },
                    onClose = viewModel::close,
                )
            }
            // A web page takes its own taps when docked: no overlay on top of it.
            if (placement == Placement.DOCKED && playerState.canPause) {
                OverlayControls(
                    channel = channel,
                    playerState = playerState,
                    canZap = state.canZap,
                    fullscreen = false,
                    onPrevious = viewModel::previous,
                    onNext = viewModel::next,
                    onToggleFullscreen = viewModel::enterFullscreen,
                    onPictureInPicture = null,
                )
            }
            if (placement == Placement.FULL && !inPip) {
                val enterPip: (() -> Unit)? = if (pipHost != null && pipHost.isPictureInPictureSupported) {
                    { pipHost.enterPictureInPicture() }
                } else {
                    null
                }
                if (playerState.canPause) {
                    OverlayControls(
                        channel = channel,
                        playerState = playerState,
                        canZap = state.canZap,
                        fullscreen = true,
                        onPrevious = viewModel::previous,
                        onNext = viewModel::next,
                        onToggleFullscreen = viewModel::exitFullscreen,
                        onPictureInPicture = enterPip,
                        onBack = viewModel::exitFullscreen,
                    )
                } else {
                    // A web page takes its own taps: only a small way back sits on top.
                    WebPageFullscreenBar(channel, onBack = viewModel::exitFullscreen, onPictureInPicture = enterPip)
                }
            }
        }
    }
}

/** Plain memo across compositions; not observed. */
private class Holder<T>(var value: T)

/** The floating window's size and where the user dragged it. */
@Stable
private class MiniWindow(
    val size: Size,
    private val margin: Float,
    private val top: Float,
    private val bottomReserve: Float,
    private val layerWidth: Float,
    private val layerHeight: Float,
) {
    /** Top-left corner; null until dragged, which means bottom-end above the tab bar. */
    var offset by mutableStateOf<Offset?>(null)
    var isDragging by mutableStateOf(false)

    val bounds: Rect
        get() = Rect(clamp(offset ?: Offset(Float.MAX_VALUE, Float.MAX_VALUE)), size)

    fun dragBy(amount: Offset) {
        offset = clamp((offset ?: bounds.topLeft) + amount)
    }

    /** Lets go against the nearer side, like a call bubble. */
    fun settle() {
        val current = bounds
        val toLeft = current.center.x < layerWidth / 2
        offset = clamp(Offset(if (toLeft) 0f else Float.MAX_VALUE, current.top))
        isDragging = false
    }

    private fun clamp(point: Offset) = Offset(
        point.x.coerceBetween(margin, layerWidth - size.width - margin),
        point.y.coerceBetween(top, layerHeight - size.height - bottomReserve),
    )

    private fun Float.coerceBetween(low: Float, high: Float) = if (high < low) low else coerceIn(low, high)
}

@Composable
private fun rememberMiniWindow(layerWidthDp: Dp, layerWidth: Float, layerHeight: Float): MiniWindow {
    val density = LocalDensity.current
    val width = with(density) { min(layerWidthDp * 0.55f, 320.dp).toPx() }
    val margin = with(density) { 12.dp.toPx() }
    val top = WindowInsets.statusBars.getTop(density) + margin
    // Clear of the bottom tab bar and the system navigation bar.
    val bottomReserve = with(density) { 68.dp.toPx() } + WindowInsets.navigationBars.getBottom(density)
    val previous = remember { Holder<MiniWindow?>(null) }
    return remember(width, margin, top, bottomReserve, layerWidth, layerHeight) {
        MiniWindow(Size(width, width * 9f / 16f), margin, top, bottomReserve, layerWidth, layerHeight)
            // Rotation or a new inset keeps where the user left the window.
            .also { it.offset = previous.value?.offset }
    }.also { previous.value = it }
}

@Composable
private fun MiniControls(
    playerState: StreamPlayerState,
    window: MiniWindow,
    onExpand: () -> Unit,
    onClose: () -> Unit,
) {
    val expand by rememberUpdatedState(onExpand)
    Box(
        Modifier
            .fillMaxSize()
            // Covers the video, web pages included: in the mini window a tap
            // opens the channel and a drag moves the window.
            .pointerInput(window) {
                detectDragGestures(
                    onDragStart = { window.isDragging = true },
                    onDragEnd = { window.settle() },
                    onDragCancel = { window.settle() },
                    onDrag = { change, amount ->
                        change.consume()
                        window.dragBy(amount)
                    },
                )
            }
            .pointerInput(Unit) { detectTapGestures(onTap = { expand() }) }
            .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.45f), Color.Transparent, Color.Black.copy(alpha = 0.45f)))),
    ) {
        OverlayButton(SportzfyIcons.Expand, "Open Live TV", onExpand, Modifier.align(Alignment.TopStart), size = 36.dp)
        OverlayButton(SportzfyIcons.Close, "Close player", onClose, Modifier.align(Alignment.TopEnd), size = 36.dp)
        if (playerState.canPause) {
            OverlayButton(
                icon = if (playerState.isPaused) SportzfyIcons.Play else SportzfyIcons.Pause,
                description = if (playerState.isPaused) "Play" else "Pause",
                onClick = playerState::togglePause,
                modifier = Modifier.align(Alignment.BottomStart),
                size = 36.dp,
            )
            OverlayButton(
                icon = if (playerState.isMuted) SportzfyIcons.VolumeOff else SportzfyIcons.VolumeOn,
                description = if (playerState.isMuted) "Unmute" else "Mute",
                onClick = playerState::toggleMute,
                modifier = Modifier.align(Alignment.BottomEnd),
                size = 36.dp,
            )
        }
    }
}

/**
 * Tap-to-show controls over a Media3 stream: previous / play-pause / next,
 * mute, full screen and, in full screen, the title bar and picture-in-picture.
 * They hide after a few seconds of playback.
 */
@Composable
private fun OverlayControls(
    channel: Channel,
    playerState: StreamPlayerState,
    canZap: Boolean,
    fullscreen: Boolean,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onToggleFullscreen: () -> Unit,
    onPictureInPicture: (() -> Unit)?,
    onBack: (() -> Unit)? = null,
) {
    var visible by remember { mutableStateOf(true) }
    // Bumped by every control press, so the overlay stays while it is being used.
    var touches by remember { mutableIntStateOf(0) }
    LaunchedEffect(visible, touches, playerState.isPaused, channel.id) {
        if (visible && !playerState.isPaused) {
            delay(CONTROLS_TIMEOUT_MILLIS)
            visible = false
        }
    }
    fun press(action: () -> Unit): () -> Unit = {
        touches++
        action()
    }

    Box(
        Modifier
            .fillMaxSize()
            .pointerInput(Unit) { detectTapGestures(onTap = { visible = !visible }) },
    ) {
        AnimatedVisibility(visible = visible, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.35f))
                    .then(if (fullscreen) Modifier.windowInsetsPadding(WindowInsets.displayCutout) else Modifier)
                    .padding(if (fullscreen) 16.dp else 8.dp),
            ) {
                if (fullscreen) {
                    Row(Modifier.align(Alignment.TopStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        onBack?.let { OverlayButton(SportzfyIcons.Back, "Exit full screen", press(it)) }
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                channel.name,
                                style = MaterialTheme.typography.titleMedium,
                                color = Color.White,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            channelSubtitle(channel)?.let {
                                Text(it, style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = 0.75f), maxLines = 1)
                            }
                        }
                        OverlayButton(
                            icon = if (playerState.isMuted) SportzfyIcons.VolumeOff else SportzfyIcons.VolumeOn,
                            description = if (playerState.isMuted) "Unmute" else "Mute",
                            onClick = press(playerState::toggleMute),
                        )
                    }
                } else {
                    OverlayButton(
                        icon = if (playerState.isMuted) SportzfyIcons.VolumeOff else SportzfyIcons.VolumeOn,
                        description = if (playerState.isMuted) "Unmute" else "Mute",
                        onClick = press(playerState::toggleMute),
                        modifier = Modifier.align(Alignment.TopEnd),
                    )
                }

                Row(
                    modifier = Modifier.align(Alignment.Center),
                    horizontalArrangement = Arrangement.spacedBy(if (fullscreen) 40.dp else 24.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (canZap) OverlayButton(SportzfyIcons.Previous, "Previous channel", press(onPrevious), size = 48.dp)
                    OverlayButton(
                        icon = if (playerState.isPaused) SportzfyIcons.Play else SportzfyIcons.Pause,
                        description = if (playerState.isPaused) "Play" else "Pause",
                        onClick = press(playerState::togglePause),
                        size = if (fullscreen) 72.dp else 60.dp,
                        background = SportzfyColors.RoseFill,
                    )
                    if (canZap) OverlayButton(SportzfyIcons.Next, "Next channel", press(onNext), size = 48.dp)
                }

                LiveBadge(Modifier.align(Alignment.BottomStart).padding(start = 4.dp, bottom = 8.dp))
                Row(Modifier.align(Alignment.BottomEnd), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    onPictureInPicture?.let { OverlayButton(SportzfyIcons.PictureInPicture, "Picture in picture", press(it)) }
                    OverlayButton(
                        icon = if (fullscreen) SportzfyIcons.ExitFullscreen else SportzfyIcons.Fullscreen,
                        description = if (fullscreen) "Exit full screen" else "Full screen",
                        onClick = press(onToggleFullscreen),
                    )
                }
            }
        }
    }
}

@Composable
private fun WebPageFullscreenBar(channel: Channel, onBack: () -> Unit, onPictureInPicture: (() -> Unit)?) {
    Row(
        Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.displayCutout)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OverlayButton(SportzfyIcons.Back, "Exit full screen", onBack, size = 40.dp)
        Spacer(Modifier.width(8.dp))
        Text(
            channel.name,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color = Color.White,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f, fill = false)
                .background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(50))
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
        Spacer(Modifier.weight(1f))
        onPictureInPicture?.let { OverlayButton(SportzfyIcons.PictureInPicture, "Picture in picture", it, size = 40.dp) }
    }
}

@Composable
private fun OverlayButton(
    @DrawableRes icon: Int,
    description: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    background: Color = Color.Black.copy(alpha = 0.45f),
) {
    IconButton(
        onClick = onClick,
        modifier = modifier
            .size(size)
            .tvFocus(CircleShape)
            .background(background, CircleShape),
    ) {
        SportzfyIcon(icon, contentDescription = description, tint = Color.White, size = size * 0.45f)
    }
}

/** "Italy · Football", or just the sport when the playlist names no country. */
internal fun channelSubtitle(channel: Channel): String? =
    listOfNotNull(channel.country, channel.category.label).joinToString(" · ").ifEmpty { null }

/** Landscape with the system bars hidden while [active]; restored afterwards. */
@Composable
private fun FullscreenWindowEffect(active: Boolean) {
    val activity = LocalContext.current.findActivity() ?: return
    DisposableEffect(activity, active) {
        if (!active) return@DisposableEffect onDispose {}
        val window = activity.window
        val previousOrientation = activity.requestedOrientation
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose {
            activity.requestedOrientation = previousOrientation
            WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
        }
    }
}

/** The screen stays on while a channel plays, wherever its window is. */
@Composable
private fun KeepScreenOnEffect(active: Boolean) {
    val view = LocalView.current
    DisposableEffect(view, active) {
        view.keepScreenOn = active
        onDispose { view.keepScreenOn = false }
    }
}

/** Whether the activity is in system picture-in-picture right now. */
@Composable
private fun rememberIsInPictureInPicture(activity: ComponentActivity?): Boolean {
    var inPip by remember(activity) {
        mutableStateOf(activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity.isInPictureInPictureMode)
    }
    DisposableEffect(activity) {
        if (activity == null) return@DisposableEffect onDispose {}
        val listener = Consumer<PictureInPictureModeChangedInfo> { inPip = it.isInPictureInPictureMode }
        activity.addOnPictureInPictureModeChangedListener(listener)
        onDispose { activity.removeOnPictureInPictureModeChangedListener(listener) }
    }
    return inPip
}

private const val CONTROLS_TIMEOUT_MILLIS = 3_500L
