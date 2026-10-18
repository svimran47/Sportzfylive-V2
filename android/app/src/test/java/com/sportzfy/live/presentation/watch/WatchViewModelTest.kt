package com.sportzfy.live.presentation.watch

import com.sportzfy.live.domain.model.DataError
import com.sportzfy.live.domain.model.Match
import com.sportzfy.live.domain.model.MatchFeed
import com.sportzfy.live.domain.model.MatchStatus.LIVE
import com.sportzfy.live.domain.model.SportCategory
import com.sportzfy.live.domain.model.StreamItem
import com.sportzfy.live.domain.model.StreamSource
import com.sportzfy.live.presentation.model.testMatch
import com.sportzfy.live.testing.FakeFavoritesRepository
import com.sportzfy.live.testing.FakeMatchRepository
import com.sportzfy.live.testing.FakeStreamRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WatchViewModelTest {

    private val madrid = testMatch("madrid", LIVE, SportCategory.FOOTBALL, home = "Real Madrid", away = "Manchester City")
    private val india = testMatch("india", LIVE, SportCategory.CRICKET, home = "India", away = "Australia")

    private val madridStreams = listOf(
        StreamItem("alpha", "madrid", 1, "Hindi", isHd = false),
        StreamItem("alpha", "madrid", 2, "English", isHd = true),
    )
    private val indiaStreams = listOf(StreamItem("alpha", "india", 1, "English", isHd = false))

    private val streamRepository = FakeStreamRepository(
        streams = mapOf(
            StreamSource("alpha", "madrid") to madridStreams,
            StreamSource("alpha", "india") to indiaStreams,
        )
    )
    private val favorites = FakeFavoritesRepository()

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun viewModel(id: String, matches: List<Match> = listOf(madrid, india)) =
        WatchViewModel(id, FakeMatchRepository(matches), streamRepository, favorites)

    private fun TestScope.collect(vm: WatchViewModel) =
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { vm.uiState.collect {} }

    @Test
    fun `loads streams and preselects English HD`() = runTest {
        val vm = viewModel("madrid")
        collect(vm)

        val state = vm.uiState.value
        assertEquals("madrid", state.match?.id)
        assertFalse(state.isResolvingStreams)
        assertEquals(2, state.streams.size)
        assertEquals("alpha/madrid/2", state.selectedStreamKey)
        assertEquals("https://embed.st/embed/alpha/madrid/2", state.selectedStream?.embedUrl)
    }

    @Test
    fun `stream picker updates the active stream`() = runTest {
        val vm = viewModel("madrid")
        collect(vm)

        vm.selectStream("alpha/madrid/1")

        assertEquals("alpha/madrid/1", vm.uiState.value.selectedStreamKey)
        assertEquals("https://embed.st/embed/alpha/madrid/1", vm.uiState.value.selectedStream?.embedUrl)
    }

    @Test
    fun `switching match reloads streams and resets the pick`() = runTest {
        val vm = viewModel("madrid")
        collect(vm)
        vm.selectStream("alpha/madrid/1")

        vm.selectMatch("india")

        val state = vm.uiState.value
        assertEquals("india", state.match?.id)
        assertEquals("alpha/india/1", state.selectedStreamKey)
        assertEquals(listOf("madrid"), state.related.map { it.id })
        assertEquals(2, streamRepository.requests.size)
    }

    @Test
    fun `unknown match is reported missing`() = runTest {
        val vm = viewModel("gone")
        collect(vm)
        assertTrue(vm.uiState.value.isMatchMissing)
        assertFalse(vm.uiState.value.isResolvingStreams)
    }

    @Test
    fun `a missing match after a failed load offers retry instead of gone`() = runTest {
        val offline = FakeMatchRepository(emptyList()).apply {
            emit(MatchFeed(emptyList(), updatedAtMillis = null, isLoading = false, error = DataError.NETWORK))
        }
        val vm = WatchViewModel("madrid", offline, streamRepository, favorites)
        collect(vm)
        assertTrue(vm.uiState.value.isMatchMissing)
        assertTrue(vm.uiState.value.isLoadFailed)

        assertFalse(viewModel("gone").also { collect(it) }.uiState.value.isLoadFailed)
    }

    @Test
    fun `failed sources are counted`() = runTest {
        val failing = FakeStreamRepository(failing = setOf(StreamSource("alpha", "madrid")))
        val vm = WatchViewModel("madrid", FakeMatchRepository(listOf(madrid)), failing, favorites)
        collect(vm)
        assertEquals(1, vm.uiState.value.failedSourceCount)
        assertTrue(vm.uiState.value.streams.isEmpty())
    }

    @Test
    fun `favorite toggles for the current match`() = runTest {
        val vm = viewModel("madrid")
        collect(vm)
        vm.toggleFavorite()
        assertTrue(vm.uiState.value.isFavorite)
        vm.toggleFavorite()
        assertFalse(vm.uiState.value.isFavorite)
    }
}
