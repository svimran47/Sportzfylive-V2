package com.sportzfy.live.presentation.about

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.sportzfy.live.core.theme.SportzfyColors
import com.sportzfy.live.core.theme.SportzfyIcon
import com.sportzfy.live.core.theme.SportzfyIcons
import com.sportzfy.live.presentation.components.SportzfyWordmark
import com.sportzfy.live.presentation.components.tvFocus

/** What the app is, where its content comes from, and what it keeps. */
@Composable
fun AboutScreen(
    onBack: () -> Unit,
    versionName: String,
    versionCode: Int,
) {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = { AboutTopBar(onBack) },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = 640.dp)
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                SportzfyWordmark()
                Text(
                    text = "Version $versionName ($versionCode)",
                    style = MaterialTheme.typography.bodyMedium,
                    color = SportzfyColors.TextSecondary,
                )
                Text(
                    text = "Sportzfy brings live sports and 24/7 sports channels together in one place.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = SportzfyColors.TextPrimary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 4.dp),
                )
                AboutCard(
                    title = "Where the content comes from",
                    lines = listOf(
                        "Matches and streams: Streamed (streamed.pk)",
                        "Live TV channels: the Sportzfy channels.json playlist",
                    ),
                )
                AboutCard(
                    title = "Your data",
                    lines = listOf(
                        "Saved matches and settings stay on this device. Sportzfy has no account and sends no personal data.",
                    ),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Streams are provided by third parties. Availability can change at any time.",
                    style = MaterialTheme.typography.bodySmall,
                    color = SportzfyColors.TextMuted,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun AboutCard(title: String, lines: List<String>) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SportzfyColors.SlateRaised, RoundedCornerShape(16.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
            color = SportzfyColors.TextPrimary,
            modifier = Modifier.semantics { heading() },
        )
        lines.forEach { line ->
            Text(
                text = line,
                style = MaterialTheme.typography.bodyMedium,
                color = SportzfyColors.TextSecondary,
            )
        }
    }
}

@Composable
private fun AboutTopBar(onBack: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .padding(end = 16.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack, modifier = Modifier.tvFocus(CircleShape)) {
            SportzfyIcon(SportzfyIcons.Back, contentDescription = "Back")
        }
        Spacer(Modifier.width(4.dp))
        Text(
            text = "About",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier
                .testTag("screen-title")
                .semantics { heading() },
        )
    }
}
