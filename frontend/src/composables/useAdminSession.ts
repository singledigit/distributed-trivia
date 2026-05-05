import { ref, computed, onUnmounted } from 'vue'
import { subscribe } from '../appsync-events'
import { listCategories as apiListCategories, createSession as apiCreateSession, startSession as apiStartSession, cancelSession as apiCancelSession, getSession as apiGetSession } from '../api'
import { useCountdown } from './useCountdown'
import QRCode from 'qrcode'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GameMode = 'timed' | 'question_count'
export type SessionPhase = 'idle' | 'loading' | 'setup' | 'lobby' | 'playing' | 'finished' | 'cancelled'

export interface Player {
  participantId: string
  displayName: string
  status: string
  score: number
  currentQuestion: number
  statusDot: string
}

export interface Category {
  categoryId: string
  categoryName: string
}

interface AdminStoredState {
  sessionId: string
  phase: SessionPhase
  players: Player[]
  sessionUrl: string
  qrCodeDataUrl: string
}

const ADMIN_STORAGE_KEY = 'trivia_admin_session'

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useAdminSession() {
  // State
  const phase = ref<SessionPhase>('idle')
  const sessionId = ref('')
  const qrCodeDataUrl = ref('')
  const sessionUrl = ref('')
  const players = ref<Player[]>([])
  const categories = ref<Category[]>([])
  const selectedCategoryId = ref('')
  const mode = ref<GameMode>('timed')
  const timeLimitMinutes = ref(3)
  const questionCount = ref(10)
  const creating = ref(false)
  const createError = ref('')
  const startTime = ref('')
  const snapshotReceived = ref(false)

  const { seconds: countdown, start: startCountdownTimer, stop: stopCountdown } = useCountdown()
  const unsubscribers: Array<() => void> = []

  // Computed
  const canStart = computed(() => players.value.length >= 1)
  const sortedPlayers = computed(() => [...players.value].sort((a, b) => b.score - a.score))
  const playerCount = computed(() => players.value.length)
  const completedCount = computed(() => players.value.filter((p) => p.status === 'completed').length)

  // -----------------------------------------------------------------------
  // State persistence
  // -----------------------------------------------------------------------

  function saveAdminState() {
    if (!sessionId.value) return
    const state: AdminStoredState = {
      sessionId: sessionId.value,
      phase: phase.value,
      players: players.value,
      sessionUrl: sessionUrl.value,
      qrCodeDataUrl: qrCodeDataUrl.value,
    }
    sessionStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(state))
  }

  function loadAdminState(): AdminStoredState | null {
    const raw = sessionStorage.getItem(ADMIN_STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as AdminStoredState
      return parsed.sessionId ? parsed : null
    } catch { return null }
  }

  function clearAdminSession() {
    sessionStorage.removeItem(ADMIN_STORAGE_KEY)
  }

  // -----------------------------------------------------------------------
  // Channel event handlers
  // -----------------------------------------------------------------------

  function handleAdminSessionEvent(event: unknown) {
    const data = event as Record<string, unknown>
    if (data.type === 'snapshot') restoreFromSnapshot(data)
    if (data.type === 'error' && data.message) {
      createError.value = data.message as string
    }
  }

  function handleLeaderboardEvent(event: unknown) {
    const data = event as Record<string, unknown>
    switch (data.type) {
      case 'snapshot':
        restoreFromSnapshot(data)
        break
      case 'player_list': {
        const incoming = (data.players as Array<Record<string, unknown>>) ?? []
        const existingMap = new Map(players.value.map((p) => [p.participantId, p]))
        players.value = incoming.map((p) => {
          const existing = existingMap.get(p.participantId as string)
          return {
            participantId: p.participantId as string,
            displayName: p.displayName as string,
            status: p.status as string,
            score: existing?.score ?? 0,
            currentQuestion: existing?.currentQuestion ?? 0,
            statusDot: existing?.statusDot ?? 'green',
          }
        })
        saveAdminState()
        break
      }
      case 'player_update': {
        const pid = data.participantId as string
        const idx = players.value.findIndex((p) => p.participantId === pid)
        if (idx >= 0) {
          players.value[idx] = {
            ...players.value[idx],
            score: (data.totalScore as number) ?? players.value[idx].score,
            currentQuestion: (data.currentQuestion as number) ?? players.value[idx].currentQuestion,
            statusDot: (data.statusDot as string) ?? players.value[idx].statusDot,
          }
          saveAdminState()
        }
        break
      }
      case 'player_completed': {
        const pid = data.participantId as string
        const idx = players.value.findIndex((p) => p.participantId === pid)
        if (idx >= 0) {
          players.value[idx] = { ...players.value[idx], status: 'completed', statusDot: 'checkmark' }
          saveAdminState()
        }
        break
      }
    }
  }

  function handleGameEvent(event: unknown) {
    const data = event as Record<string, unknown>
    switch (data.type) {
      case 'game_started':
        startTime.value = data.startTime as string
        phase.value = 'playing'
        startCountdownTimer(startTime.value)
        saveAdminState()
        break
      case 'times_up':
        stopCountdown()
        phase.value = 'finished'
        saveAdminState()
        break
      case 'game_cancelled':
        stopCountdown()
        phase.value = 'cancelled'
        saveAdminState()
        break
    }
  }

  // -----------------------------------------------------------------------
  // Snapshot restore
  // -----------------------------------------------------------------------

  function restoreFromSnapshot(data: Record<string, unknown>) {
    snapshotReceived.value = true
    if (data.sessionId) sessionId.value = data.sessionId as string

    if (Array.isArray(data.players)) {
      players.value = (data.players as Array<Record<string, unknown>>).map((p) => ({
        participantId: p.participantId as string,
        displayName: p.displayName as string,
        status: p.status as string,
        score: (p.score as number) ?? 0,
        currentQuestion: (p.currentQuestion as number) ?? 0,
        statusDot: (p.statusDot as string) ?? 'green',
      }))
    }

    switch (data.status as string) {
      case 'waiting': phase.value = 'lobby'; break
      case 'in_progress': phase.value = 'playing'; break
      case 'completed': phase.value = 'finished'; break
      case 'cancelled': phase.value = 'cancelled'; break
    }

    saveAdminState()
  }

  // -----------------------------------------------------------------------
  // Subscriptions
  // -----------------------------------------------------------------------

  async function subscribeToSessionChannels(sid: string) {
    const u1 = await subscribe(`/admin/${sid}`, handleAdminSessionEvent)
    const u2 = await subscribe(`/leaderboard/${sid}`, handleLeaderboardEvent)
    const u3 = await subscribe(`/game/${sid}`, handleGameEvent)
    unsubscribers.push(u1, u2, u3)
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  async function generateQR(sid: string) {
    const playUrl = `${window.location.origin}/play/${sid}`
    sessionUrl.value = playUrl
    qrCodeDataUrl.value = await QRCode.toDataURL(playUrl, {
      width: 280, margin: 2, color: { dark: '#f0eef5', light: '#00000000' },
    })
  }

  function copyUrl() {
    if (sessionUrl.value) navigator.clipboard.writeText(sessionUrl.value).catch(() => {})
  }

  // -----------------------------------------------------------------------
  // Initialize — subscribe to channels, restore state
  // -----------------------------------------------------------------------

  async function initialize() {
    phase.value = 'loading'

    // Fetch categories via REST
    try {
      const cats = await apiListCategories()
      categories.value = cats.map(c => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
      })).sort((a, b) => a.categoryName.localeCompare(b.categoryName))
      if (categories.value.length > 0 && !selectedCategoryId.value) {
        selectedCategoryId.value = categories.value[0].categoryId
      }
    } catch (err) {
      console.error('[admin] Failed to fetch categories:', err)
    }

    const cached = loadAdminState()
    if (cached) {
      sessionId.value = cached.sessionId
      phase.value = cached.phase
      players.value = cached.players
      sessionUrl.value = cached.sessionUrl
      qrCodeDataUrl.value = cached.qrCodeDataUrl

      await subscribeToSessionChannels(cached.sessionId)
      if (!qrCodeDataUrl.value) await generateQR(cached.sessionId)

      // Restore state from REST API
      snapshotReceived.value = false
      try {
        const snapshot = await apiGetSession(cached.sessionId)
        restoreFromSnapshot(snapshot as unknown as Record<string, unknown>)
      } catch {
        // REST failed — cached state is still shown
      }
    } else {
      phase.value = 'setup'
    }
  }

  // -----------------------------------------------------------------------
  // Game actions
  // -----------------------------------------------------------------------

  let createStartTime = 0

  async function createSession() {
    if (!selectedCategoryId.value) {
      createError.value = 'Please select a category'
      return
    }
    creating.value = true
    createError.value = ''
    createStartTime = Date.now()

    try {
      // Generate sessionId client-side so we can subscribe before the ODF starts
      const newSessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()
      sessionId.value = newSessionId
      await generateQR(newSessionId)
      await subscribeToSessionChannels(newSessionId)

      // Now create via REST — ODF will publish to channels we're already on
      await apiCreateSession({
        categoryId: selectedCategoryId.value,
        mode: mode.value,
        sessionId: newSessionId,
        ...(mode.value === 'timed'
          ? { timeLimitMinutes: timeLimitMinutes.value }
          : { questionCount: questionCount.value }),
      })

      if (createStartTime) {
        console.log(`[timing] Create → Ack: ${Date.now() - createStartTime}ms`)
        createStartTime = 0
      }
      creating.value = false
      phase.value = 'lobby'
      saveAdminState()
    } catch (err: unknown) {
      createError.value = err instanceof Error ? err.message : 'Failed to create session'
      creating.value = false
    }
  }

  async function startGame() {
    try {
      await apiStartSession(sessionId.value)
    } catch (err) {
      console.error('Failed to start game', err)
    }
  }

  async function cancelGame() {
    try {
      await apiCancelSession(sessionId.value)
    } catch (err) {
      console.error('Failed to cancel game', err)
    }
  }

  function newGame() {
    clearAdminSession()
    sessionId.value = ''
    players.value = []
    qrCodeDataUrl.value = ''
    sessionUrl.value = ''
    phase.value = 'setup'
  }

  // Cleanup
  onUnmounted(() => {
    for (const unsub of unsubscribers) unsub()
  })

  return {
    // State
    phase,
    sessionId,
    qrCodeDataUrl,
    sessionUrl,
    players,
    categories,
    selectedCategoryId,
    mode,
    timeLimitMinutes,
    questionCount,
    creating,
    createError,
    countdown,
    // Computed
    canStart,
    sortedPlayers,
    playerCount,
    completedCount,
    // Actions
    initialize,
    createSession,
    startGame,
    cancelGame,
    newGame,
    copyUrl,
  }
}
