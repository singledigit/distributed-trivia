<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { subscribe, publish } from '../appsync-events'
import QRCode from 'qrcode'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GameMode = 'timed' | 'question_count'
type Phase = 'loading' | 'setup' | 'lobby' | 'playing' | 'finished' | 'cancelled'

interface Player {
  participantId: string
  displayName: string
  status: string
  score: number
  currentQuestion: number
  statusDot: string
}

interface Category {
  categoryId: string
  categoryName: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const phase = ref<Phase>('loading')
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
const countdown = ref(0)
let countdownInterval: ReturnType<typeof setInterval> | null = null
const unsubscribers: Array<() => void> = []
const snapshotReceived = ref(false)

const ADMIN_STORAGE_KEY = 'trivia_admin_session'

// ---------------------------------------------------------------------------
// Single event handler for /admin/default — handles ALL admin events
// ---------------------------------------------------------------------------

function handleDefaultChannelEvent(event: unknown) {
  const data = event as Record<string, unknown>

  switch (data.type) {
    case 'categories':
      if (Array.isArray(data.categories)) {
        categories.value = (data.categories as Array<Record<string, string>>).map((c) => ({
          categoryId: c.categoryId,
          categoryName: c.categoryName,
        }))
        if (categories.value.length > 0 && !selectedCategoryId.value) {
          selectedCategoryId.value = categories.value[0].categoryId
        }
      }
      break

    case 'ack':
      // Create session ack — sessionId is here
      if (data.sessionId && !sessionId.value) {
        handleCreateAck(data.sessionId as string)
      }
      break

    case 'session_created':
      // ODF confirmed session is ready — we're already in lobby from handleCreateAck
      break
  }
}

// ---------------------------------------------------------------------------
// Session-specific channel handlers
// ---------------------------------------------------------------------------

function handleAdminSessionEvent(event: unknown) {
  const data = event as Record<string, unknown>
  if (data.type === 'snapshot') restoreFromSnapshot(data)
  if (data.type === 'session_created') { /* already in lobby */ }
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
      }
      break
    }
    case 'player_completed': {
      const pid = data.participantId as string
      const idx = players.value.findIndex((p) => p.participantId === pid)
      if (idx >= 0) {
        players.value[idx] = { ...players.value[idx], status: 'completed', statusDot: 'checkmark' }
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
      runCountdown()
      break
    case 'times_up':
      stopCountdown()
      phase.value = 'finished'
      break
    case 'game_cancelled':
      stopCountdown()
      phase.value = 'cancelled'
      break
  }
}

// ---------------------------------------------------------------------------
// Lifecycle — clean, sequential, no races
// ---------------------------------------------------------------------------

onMounted(async () => {
  // Step 1: Subscribe to /admin/default — permanent for the life of this component
  const unsub = await subscribe('/admin/default', handleDefaultChannelEvent)
  unsubscribers.push(unsub)

  // Step 2: Fetch categories
  await publish('/admin/default', [{ action: 'categories' }])

  // Step 3: Check for existing session
  const savedSessionId = sessionStorage.getItem(ADMIN_STORAGE_KEY)
  if (savedSessionId) {
    sessionId.value = savedSessionId
    snapshotReceived.value = false
    await generateQR(savedSessionId)
    // Stay in loading while we check — don't show lobby yet
    await subscribeToSessionChannels(savedSessionId)

    // Wait up to 3s for snapshot. If it arrives, restoreFromSnapshot sets the phase.
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => resolve(), 3000)
      const check = setInterval(() => {
        if (snapshotReceived.value) {
          clearTimeout(timeout)
          clearInterval(check)
          resolve()
        }
      }, 100)
    })

    if (!snapshotReceived.value) {
      // Session expired — clean up and show create form
      clearAdminSession()
      sessionId.value = ''
      qrCodeDataUrl.value = ''
      sessionUrl.value = ''
      phase.value = 'setup'
    }
  } else {
    phase.value = 'setup'
  }
})

onUnmounted(() => {
  for (const unsub of unsubscribers) unsub()
  stopCountdown()
})

// ---------------------------------------------------------------------------
// Create session — publish on the already-subscribed /admin/default channel
// ---------------------------------------------------------------------------

async function createSession() {
  if (!selectedCategoryId.value) {
    createError.value = 'Please select a category'
    return
  }
  creating.value = true
  createError.value = ''

  try {
    // The ack will arrive via handleDefaultChannelEvent → 'ack' case
    await publish('/admin/default', [
      {
        action: 'create',
        categoryId: selectedCategoryId.value,
        mode: mode.value,
        ...(mode.value === 'timed'
          ? { timeLimitMinutes: timeLimitMinutes.value }
          : { questionCount: questionCount.value }),
      },
    ])
    // handleCreateAck will be called when the ack event arrives
  } catch (err: unknown) {
    createError.value = err instanceof Error ? err.message : 'Failed to create session'
    creating.value = false
  }
}

async function handleCreateAck(newSessionId: string) {
  sessionId.value = newSessionId
  sessionStorage.setItem(ADMIN_STORAGE_KEY, newSessionId)
  await generateQR(newSessionId)
  await subscribeToSessionChannels(newSessionId)
  creating.value = false
  phase.value = 'lobby'
}

// ---------------------------------------------------------------------------
// Subscribe to session-specific channels
// ---------------------------------------------------------------------------

async function subscribeToSessionChannels(sid: string) {
  const u1 = await subscribe(`/admin/${sid}`, handleAdminSessionEvent)
  const u2 = await subscribe(`/leaderboard/${sid}`, handleLeaderboardEvent)
  const u3 = await subscribe(`/game/${sid}`, handleGameEvent)
  unsubscribers.push(u1, u2, u3)
}

// ---------------------------------------------------------------------------
// State restore from snapshot
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Game controls
// ---------------------------------------------------------------------------

async function startGame() {
  try {
    await publish(`/admin/${sessionId.value}`, [{ action: 'start' }])
  } catch (err) {
    console.error('Failed to start game', err)
  }
}

async function cancelGame() {
  try {
    await publish(`/admin/${sessionId.value}`, [{ action: 'cancel' }])
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function generateQR(sid: string) {
  const playUrl = `${window.location.origin}/play/${sid}`
  sessionUrl.value = playUrl
  qrCodeDataUrl.value = await QRCode.toDataURL(playUrl, {
    width: 256, margin: 2, color: { dark: '#08060d', light: '#ffffff' },
  })
}

function clearAdminSession() {
  sessionStorage.removeItem(ADMIN_STORAGE_KEY)
}

function runCountdown() {
  if (!startTime.value) return
  const tick = () => {
    const diff = Math.max(0, Math.ceil((new Date(startTime.value).getTime() - Date.now()) / 1000))
    countdown.value = diff
    if (diff <= 0 && countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
  }
  tick()
  countdownInterval = setInterval(tick, 250)
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
  countdown.value = 0
}

function copyUrl() {
  if (sessionUrl.value) navigator.clipboard.writeText(sessionUrl.value).catch(() => {})
}

const canStart = computed(() => players.value.length >= 1)
const sortedPlayers = computed(() => [...players.value].sort((a, b) => b.score - a.score))
const playerCount = computed(() => players.value.length)
const completedCount = computed(() => players.value.filter((p) => p.status === 'completed').length)
</script>

<template>
  <div class="admin-view">
    <h1>🎮 Game Controller</h1>

    <!-- LOADING -->
    <div v-if="phase === 'loading'" class="phase-loading">
      <p>Connecting…</p>
    </div>

    <!-- SETUP -->
    <div v-if="phase === 'setup'" class="phase-setup">
      <div class="form-card">
        <h2>Create a Trivia Session</h2>

        <div class="field">
          <label for="category">Category</label>
          <select id="category" v-model="selectedCategoryId" class="input">
            <option v-if="categories.length === 0" value="" disabled>Loading…</option>
            <option v-for="cat in categories" :key="cat.categoryId" :value="cat.categoryId">
              {{ cat.categoryName }}
            </option>
          </select>
        </div>

        <div class="field">
          <label>Game Mode</label>
          <div class="toggle-group">
            <button :class="['toggle-btn', { active: mode === 'timed' }]" @click="mode = 'timed'">⏱️ Timed</button>
            <button :class="['toggle-btn', { active: mode === 'question_count' }]" @click="mode = 'question_count'">📝 Question Count</button>
          </div>
        </div>

        <div v-if="mode === 'timed'" class="field">
          <label for="timeLimit">Time Limit (minutes)</label>
          <input id="timeLimit" v-model.number="timeLimitMinutes" type="number" min="1" max="5" class="input input-narrow" />
          <p class="hint">1–5 minutes</p>
        </div>

        <div v-if="mode === 'question_count'" class="field">
          <label for="questionCount">Number of Questions</label>
          <input id="questionCount" v-model.number="questionCount" type="number" min="1" max="30" class="input input-narrow" />
          <p class="hint">1–30 questions</p>
        </div>

        <button class="btn btn-primary" :disabled="creating || !selectedCategoryId" @click="createSession">
          {{ creating ? 'Creating…' : 'Create Session' }}
        </button>
        <p v-if="createError" class="error">{{ createError }}</p>
      </div>
    </div>

    <!-- LOBBY -->
    <div v-if="phase === 'lobby'" class="phase-lobby">
      <div class="lobby-header">
        <h2>Session Ready</h2>
        <p class="session-id">Session: <code>{{ sessionId }}</code></p>
      </div>
      <div class="lobby-content">
        <div class="qr-section">
          <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="QR code to join game" class="qr-code" />
          <p class="join-url"><a :href="sessionUrl" target="_blank">{{ sessionUrl }}</a></p>
          <button class="btn btn-small" @click="copyUrl">📋 Copy Link</button>
        </div>
        <div class="players-section">
          <h3>Players ({{ playerCount }})</h3>
          <div v-if="players.length === 0" class="empty-state">Waiting for players to join…</div>
          <ul v-else class="player-list">
            <li v-for="p in players" :key="p.participantId" class="player-item">
              <span class="dot dot-green"></span>
              <span class="player-name">{{ p.displayName }}</span>
            </li>
          </ul>
        </div>
      </div>
      <div class="lobby-controls">
        <button class="btn btn-primary" :disabled="!canStart" @click="startGame">🚀 Start Game</button>
        <button class="btn btn-danger" @click="cancelGame">✕ Cancel</button>
      </div>
    </div>

    <!-- PLAYING -->
    <div v-if="phase === 'playing'" class="phase-playing">
      <div class="game-header">
        <h2>Game In Progress</h2>
        <div v-if="countdown > 0" class="countdown-display">Starting in <span class="countdown-number">{{ countdown }}</span>s</div>
        <div v-else class="game-live">🔴 LIVE</div>
      </div>
      <div class="game-stats">
        <div class="stat"><span class="stat-value">{{ playerCount }}</span><span class="stat-label">Players</span></div>
        <div class="stat"><span class="stat-value">{{ completedCount }}</span><span class="stat-label">Finished</span></div>
      </div>
      <div class="leaderboard">
        <h3>Leaderboard</h3>
        <table v-if="sortedPlayers.length > 0" class="leaderboard-table">
          <thead><tr><th>#</th><th>Player</th><th>Q</th><th>Score</th><th>Status</th></tr></thead>
          <tbody>
            <tr v-for="(p, i) in sortedPlayers" :key="p.participantId">
              <td>{{ i + 1 }}</td><td>{{ p.displayName }}</td><td>{{ p.currentQuestion }}</td>
              <td class="score-cell">{{ p.score }}</td><td><span :class="['dot', `dot-${p.statusDot}`]"></span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="game-controls"><button class="btn btn-danger" @click="cancelGame">✕ End Game</button></div>
    </div>

    <!-- FINISHED -->
    <div v-if="phase === 'finished'" class="phase-finished">
      <h2>🏆 Game Over</h2>
      <div class="final-results">
        <table v-if="sortedPlayers.length > 0" class="leaderboard-table">
          <thead><tr><th>Rank</th><th>Player</th><th>Questions</th><th>Score</th></tr></thead>
          <tbody>
            <tr v-for="(p, i) in sortedPlayers" :key="p.participantId" :class="{ 'top-player': i === 0 }">
              <td><span v-if="i === 0">🥇</span><span v-else-if="i === 1">🥈</span><span v-else-if="i === 2">🥉</span><span v-else>{{ i + 1 }}</span></td>
              <td>{{ p.displayName }}</td><td>{{ p.currentQuestion }}</td><td class="score-cell">{{ p.score }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <button class="btn btn-primary" @click="newGame">New Game</button>
    </div>

    <!-- CANCELLED -->
    <div v-if="phase === 'cancelled'" class="phase-cancelled">
      <h2>Game Cancelled</h2>
      <p>The session was cancelled.</p>
      <button class="btn btn-primary" @click="newGame">New Game</button>
    </div>
  </div>
</template>

<style scoped>
.admin-view { max-width: 640px; margin: 0 auto; padding: 32px 20px; }
h1 { font-size: 32px; margin: 0 0 24px; text-align: center; }
h2 { margin: 0 0 16px; }
h3 { margin: 0 0 12px; font-size: 18px; }
.phase-loading { text-align: center; padding: 60px 0; color: var(--text); }
.form-card { background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
.field { margin-bottom: 20px; }
.field label { display: block; font-weight: 500; color: var(--text-h); margin-bottom: 6px; font-size: 14px; }
.input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 16px; font-family: var(--sans); background: var(--bg); color: var(--text-h); box-sizing: border-box; }
.input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.input-narrow { width: 120px; }
.hint { font-size: 13px; color: var(--text); margin: 4px 0 0; }
.toggle-group { display: flex; gap: 8px; }
.toggle-btn { flex: 1; padding: 10px 16px; border: 2px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 15px; font-family: var(--sans); cursor: pointer; transition: all 0.15s; }
.toggle-btn:hover { border-color: var(--accent-border); }
.toggle-btn.active { border-color: var(--accent); background: var(--accent-bg); color: var(--text-h); }
.btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 16px; font-family: var(--sans); font-weight: 500; cursor: pointer; transition: opacity 0.15s; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { opacity: 0.9; }
.btn-danger { background: #dc2626; color: #fff; }
.btn-danger:hover:not(:disabled) { opacity: 0.9; }
.btn-small { padding: 6px 14px; font-size: 14px; background: var(--social-bg); color: var(--text-h); border: 1px solid var(--border); }
.error { color: #dc2626; margin-top: 12px; font-size: 14px; }
.lobby-header { text-align: center; margin-bottom: 24px; }
.session-id { font-size: 14px; color: var(--text); }
.session-id code { font-size: 13px; }
.lobby-content { display: flex; gap: 32px; margin-bottom: 24px; }
@media (max-width: 600px) { .lobby-content { flex-direction: column; align-items: center; } }
.qr-section { text-align: center; flex-shrink: 0; }
.qr-code { width: 200px; height: 200px; border-radius: 12px; border: 1px solid var(--border); }
.join-url { font-size: 13px; margin: 8px 0; word-break: break-all; }
.join-url a { color: var(--accent); text-decoration: none; }
.players-section { flex: 1; min-width: 0; }
.empty-state { color: var(--text); font-style: italic; padding: 20px 0; }
.player-list { list-style: none; padding: 0; margin: 0; }
.player-item { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 15px; color: var(--text-h); }
.player-name { font-weight: 500; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.dot-green { background: #22c55e; }
.dot-amber { background: #f59e0b; }
.dot-red { background: #ef4444; }
.dot-checkmark { background: #22c55e; position: relative; }
.dot-checkmark::after { content: '✓'; position: absolute; top: -3px; left: 1px; font-size: 8px; color: #fff; }
.lobby-controls { display: flex; gap: 12px; justify-content: center; }
.game-header { text-align: center; margin-bottom: 24px; }
.countdown-display { font-size: 20px; color: var(--text); margin-top: 8px; }
.countdown-number { font-size: 32px; font-weight: 700; color: var(--accent); font-family: var(--mono); }
.game-live { font-size: 18px; font-weight: 600; color: #ef4444; margin-top: 8px; animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.game-stats { display: flex; gap: 24px; justify-content: center; margin-bottom: 24px; }
.stat { text-align: center; }
.stat-value { display: block; font-size: 28px; font-weight: 700; color: var(--text-h); font-family: var(--mono); }
.stat-label { font-size: 13px; color: var(--text); }
.leaderboard { margin-bottom: 24px; }
.leaderboard-table { width: 100%; border-collapse: collapse; font-size: 15px; }
.leaderboard-table th { text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--border); font-size: 13px; color: var(--text); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
.leaderboard-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-h); }
.score-cell { font-weight: 600; font-family: var(--mono); }
.top-player td { background: var(--accent-bg); }
.game-controls { text-align: center; }
.phase-finished, .phase-cancelled { text-align: center; }
.final-results { margin: 24px 0; }
.phase-cancelled p { color: var(--text); margin-bottom: 24px; }
</style>
