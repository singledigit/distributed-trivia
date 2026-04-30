<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { subscribe, publish } from '../appsync-events'
import { signIn, completeNewPassword, isAuthenticated, loadSession } from '../auth'
import AppHeader from '../components/AppHeader.vue'
import QRCode from 'qrcode'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GameMode = 'timed' | 'question_count'
type Phase = 'login' | 'new_password' | 'loading' | 'setup' | 'lobby' | 'playing' | 'finished' | 'cancelled'

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
// Auth state
// ---------------------------------------------------------------------------

const loginUsername = ref('')
const loginPassword = ref('')
const loginError = ref('')
const loggingIn = ref(false)
const newPassword = ref('')
const newPasswordConfirm = ref('')
const challengeSession = ref('')
const adminUsername = ref('')

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const phase = ref<Phase>('login')
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
// Admin state persistence (Option B — instant restore on refresh)
// ---------------------------------------------------------------------------

interface AdminStoredState {
  sessionId: string
  phase: Phase
  players: Player[]
  sessionUrl: string
  qrCodeDataUrl: string
}

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
        })).sort((a, b) => a.categoryName.localeCompare(b.categoryName))
        if (categories.value.length > 0 && !selectedCategoryId.value) {
          selectedCategoryId.value = categories.value[0].categoryId
        }
      }
      break

    case 'ack':
      if (data.sessionId && !sessionId.value) {
        handleCreateAck(data.sessionId as string)
      }
      break

    case 'session_created':
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
      runCountdown()
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auth actions
// ---------------------------------------------------------------------------

async function handleLogin() {
  loginError.value = ''
  loggingIn.value = true

  const result = await signIn(loginUsername.value, loginPassword.value)

  if (result.challengeName === 'NEW_PASSWORD_REQUIRED') {
    challengeSession.value = result.challengeSession!
    adminUsername.value = loginUsername.value
    loggingIn.value = false
    phase.value = 'new_password'
    return
  }

  if (result.success) {
    adminUsername.value = result.session!.username
    loggingIn.value = false
    await initializeAdmin()
    return
  }

  loginError.value = result.error ?? 'Sign in failed'
  loggingIn.value = false
}

async function handleNewPassword() {
  if (newPassword.value !== newPasswordConfirm.value) {
    loginError.value = 'Passwords do not match'
    return
  }
  if (newPassword.value.length < 8) {
    loginError.value = 'Password must be at least 8 characters'
    return
  }

  loginError.value = ''
  loggingIn.value = true

  const result = await completeNewPassword(adminUsername.value, newPassword.value, challengeSession.value)

  if (result.success) {
    loggingIn.value = false
    await initializeAdmin()
    return
  }

  loginError.value = result.error ?? 'Password change failed'
  loggingIn.value = false
}

async function initializeAdmin() {
  phase.value = 'loading'
  adminUsername.value = loadSession()?.username ?? ''

  // Step 1: Subscribe to /admin/default
  const unsub = await subscribe('/admin/default', handleDefaultChannelEvent)
  unsubscribers.push(unsub)

  // Step 1b: Subscribe to /categories/default for category list
  const catUnsub = await subscribe('/categories/default', handleDefaultChannelEvent)
  unsubscribers.push(catUnsub)

  // Step 2: Fetch categories
  await publish('/categories/default', [{ action: 'list' }])

  // Step 3: Check for existing session — restore from cache immediately (Option B)
  const cached = loadAdminState()
  if (cached) {
    // Instant restore from cache — no blank screen
    sessionId.value = cached.sessionId
    phase.value = cached.phase
    players.value = cached.players
    sessionUrl.value = cached.sessionUrl
    qrCodeDataUrl.value = cached.qrCodeDataUrl

    // Subscribe to session channels for live updates
    await subscribeToSessionChannels(cached.sessionId)
    if (!qrCodeDataUrl.value) await generateQR(cached.sessionId)

    // Option A: request fresh state from server to correct any drift
    snapshotReceived.value = false
    try {
      await publish(`/admin/${cached.sessionId}`, [{ action: 'status' }])
    } catch { /* status request failed — cached state is still shown */ }

    // Wait briefly for snapshot from onSubscribe handler
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => resolve(), 5000)
      const check = setInterval(() => {
        if (snapshotReceived.value) {
          clearTimeout(timeout)
          clearInterval(check)
          resolve()
        }
      }, 100)
    })

    // If snapshot arrived, it already updated the state via restoreFromSnapshot
    // If not, we're still showing the cached state — good enough
  } else {
    // No cached session — check legacy storage key (just sessionId)
    const legacySessionId = sessionStorage.getItem(ADMIN_STORAGE_KEY)
    if (legacySessionId && typeof legacySessionId === 'string' && !legacySessionId.startsWith('{')) {
      sessionId.value = legacySessionId
      snapshotReceived.value = false
      await generateQR(legacySessionId)
      await subscribeToSessionChannels(legacySessionId)

      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => resolve(), 8000)
        const check = setInterval(() => {
          if (snapshotReceived.value) {
            clearTimeout(timeout)
            clearInterval(check)
            resolve()
          }
        }, 100)
      })

      if (!snapshotReceived.value) {
        clearAdminSession()
        sessionId.value = ''
        qrCodeDataUrl.value = ''
        sessionUrl.value = ''
        phase.value = 'setup'
      }
    } else {
      phase.value = 'setup'
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  // Check if already authenticated
  if (isAuthenticated()) {
    await initializeAdmin()
  }
  // Otherwise stay on login phase
})

onUnmounted(() => {
  for (const unsub of unsubscribers) unsub()
  stopCountdown()
})

// ---------------------------------------------------------------------------
// Create session
// ---------------------------------------------------------------------------

// Track create-to-ready timing
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
  } catch (err: unknown) {
    createError.value = err instanceof Error ? err.message : 'Failed to create session'
    creating.value = false
  }
}

async function handleCreateAck(newSessionId: string) {
  if (createStartTime) {
    const elapsed = Date.now() - createStartTime
    console.log(`[timing] Create → Ack: ${elapsed}ms`)
    createStartTime = 0
  }
  sessionId.value = newSessionId
  sessionStorage.setItem(ADMIN_STORAGE_KEY, newSessionId)
  await generateQR(newSessionId)
  await subscribeToSessionChannels(newSessionId)
  creating.value = false
  phase.value = 'lobby'
  saveAdminState()
}

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

  saveAdminState()
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
    width: 280, margin: 2, color: { dark: '#f0eef5', light: '#00000000' },
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
  <div class="admin">
    <!-- Ambient background -->
    <div class="bg-grid" />
    <div class="bg-orb bg-orb-gold" />
    <div class="bg-orb bg-orb-cyan" />

    <div class="admin-inner">
      <AppHeader active-page="game" :show-nav="phase !== 'login' && phase !== 'new_password'" />

      <!-- LOGIN -->
      <div v-if="phase === 'login'" class="phase-login">
        <div class="setup-hero">
          <h1 class="setup-title">Host Login</h1>
          <p class="setup-sub">Sign in to create and manage trivia games.</p>
        </div>
        <div class="card">
          <form class="login-form" @submit.prevent="handleLogin">
            <div class="field">
              <label for="username">Email</label>
              <input id="username" v-model="loginUsername" type="email" class="input" autocomplete="username" placeholder="you@example.com" />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" v-model="loginPassword" type="password" class="input" autocomplete="current-password" />
            </div>
            <button type="submit" class="btn btn-gold btn-full" :disabled="loggingIn || !loginUsername || !loginPassword">
              <span v-if="loggingIn" class="spinner" />
              {{ loggingIn ? 'Signing in…' : 'Sign In' }}
            </button>
            <p v-if="loginError" class="error-msg">{{ loginError }}</p>
          </form>
        </div>
      </div>

      <!-- NEW PASSWORD -->
      <div v-if="phase === 'new_password'" class="phase-login">
        <div class="setup-hero">
          <h1 class="setup-title">Set New Password</h1>
          <p class="setup-sub">Your temporary password needs to be changed.</p>
        </div>
        <div class="card">
          <form class="login-form" @submit.prevent="handleNewPassword">
            <div class="field">
              <label for="newPw">New Password</label>
              <input id="newPw" v-model="newPassword" type="password" class="input" autocomplete="new-password" />
            </div>
            <div class="field">
              <label for="confirmPw">Confirm Password</label>
              <input id="confirmPw" v-model="newPasswordConfirm" type="password" class="input" autocomplete="new-password" />
            </div>
            <button type="submit" class="btn btn-gold btn-full" :disabled="loggingIn || !newPassword || !newPasswordConfirm">
              <span v-if="loggingIn" class="spinner" />
              {{ loggingIn ? 'Updating…' : 'Set Password' }}
            </button>
            <p v-if="loginError" class="error-msg">{{ loginError }}</p>
          </form>
        </div>
      </div>

      <!-- LOADING -->
      <div v-if="phase === 'loading'" class="phase-center">
        <div class="loader" />
        <p class="phase-msg">Connecting…</p>
      </div>

      <!-- SETUP -->
      <div v-if="phase === 'setup'" class="phase-setup">
        <div class="setup-hero">
          <h1 class="setup-title">New Game</h1>
          <p class="setup-sub">Configure your trivia session and invite players.</p>
        </div>

        <div class="card">
          <div class="field">
            <label for="category">Category</label>
            <div class="select-wrap">
              <select id="category" v-model="selectedCategoryId">
                <option v-if="categories.length === 0" value="" disabled>Loading…</option>
                <option v-for="cat in categories" :key="cat.categoryId" :value="cat.categoryId">
                  {{ cat.categoryName }}
                </option>
              </select>
              <span class="select-arrow">▾</span>
            </div>
          </div>

          <div class="field">
            <label>Game Mode</label>
            <div class="toggle-row">
              <button :class="['toggle-btn', { active: mode === 'timed' }]" @click="mode = 'timed'">
                <span class="toggle-icon">⏱</span> Timed
              </button>
              <button :class="['toggle-btn', { active: mode === 'question_count' }]" @click="mode = 'question_count'">
                <span class="toggle-icon">#</span> Question Count
              </button>
            </div>
          </div>

          <div v-if="mode === 'timed'" class="field">
            <label for="timeLimit">Time Limit</label>
            <div class="stepper">
              <button class="stepper-btn" @click="timeLimitMinutes = Math.max(1, timeLimitMinutes - 1)">−</button>
              <span class="stepper-value">{{ timeLimitMinutes }} min</span>
              <button class="stepper-btn" @click="timeLimitMinutes = Math.min(5, timeLimitMinutes + 1)">+</button>
            </div>
          </div>

          <div v-if="mode === 'question_count'" class="field">
            <label for="questionCount">Questions</label>
            <div class="stepper">
              <button class="stepper-btn" @click="questionCount = Math.max(1, questionCount - 1)">−</button>
              <span class="stepper-value">{{ questionCount }}</span>
              <button class="stepper-btn" @click="questionCount = Math.min(30, questionCount + 1)">+</button>
            </div>
          </div>

          <button class="btn btn-gold btn-full" :disabled="creating || !selectedCategoryId" @click="createSession">
            <span v-if="creating" class="spinner" />
            {{ creating ? 'Creating…' : 'Create Session' }}
          </button>
          <p v-if="createError" class="error-msg">{{ createError }}</p>
        </div>
      </div>

      <!-- LOBBY -->
      <div v-if="phase === 'lobby'" class="phase-lobby">
        <div class="lobby-top">
          <h1 class="section-title">Lobby</h1>
          <span class="mono-badge">{{ sessionId.slice(0, 8) }}</span>
        </div>

        <div class="lobby-grid">
          <div class="card qr-card">
            <p class="card-label">Scan to Join</p>
            <div class="qr-frame">
              <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="QR code to join game" class="qr-img" />
            </div>
            <div class="qr-url">
              <a :href="sessionUrl" target="_blank" rel="noopener">{{ sessionUrl }}</a>
            </div>
            <button class="btn btn-ghost btn-sm" @click="copyUrl">Copy Link</button>
          </div>

          <div class="card players-card">
            <div class="card-header">
              <p class="card-label">Players</p>
              <span class="count-pill">{{ playerCount }}</span>
            </div>
            <div v-if="players.length === 0" class="empty-players">
              <div class="empty-pulse" />
              <p>Waiting for players…</p>
            </div>
            <ul v-else class="player-list">
              <li v-for="(p, i) in players" :key="p.participantId" class="player-item" :style="{ animationDelay: i * 60 + 'ms' }">
                <span class="player-avatar">{{ p.displayName.charAt(0).toUpperCase() }}</span>
                <span class="player-name">{{ p.displayName }}</span>
              </li>
            </ul>
          </div>
        </div>

        <div class="lobby-actions">
          <button class="btn btn-gold btn-lg" :disabled="!canStart" @click="startGame">Start Game</button>
          <a :href="`/leaderboard/${sessionId}`" target="_blank" class="btn btn-ghost">Open Leaderboard ↗</a>
          <button class="btn btn-ghost-danger" @click="cancelGame">Cancel</button>
        </div>
      </div>

      <!-- PLAYING -->
      <div v-if="phase === 'playing'" class="phase-playing">
        <div class="playing-header">
          <h1 class="section-title">Live Game</h1>
          <div v-if="countdown > 0" class="countdown-chip">
            Starting in <span class="countdown-num">{{ countdown }}</span>
          </div>
          <div v-else class="live-chip">
            <span class="live-dot" /> LIVE
          </div>
        </div>

        <div class="stats-row">
          <div class="stat-card">
            <span class="stat-num">{{ playerCount }}</span>
            <span class="stat-label">Players</span>
          </div>
          <div class="stat-card">
            <span class="stat-num">{{ completedCount }}</span>
            <span class="stat-label">Finished</span>
          </div>
        </div>

        <div class="card">
          <p class="card-label">Leaderboard</p>
          <table v-if="sortedPlayers.length > 0" class="lb-table">
            <thead>
              <tr>
                <th class="col-rank">#</th>
                <th>Player</th>
                <th class="col-q">Q</th>
                <th class="col-score">Score</th>
                <th class="col-status"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in sortedPlayers" :key="p.participantId" :class="{ 'row-first': i === 0 }">
                <td class="col-rank rank-num">{{ i + 1 }}</td>
                <td class="player-cell">{{ p.displayName }}</td>
                <td class="col-q mono">{{ p.currentQuestion }}</td>
                <td class="col-score mono score-val">{{ p.score }}</td>
                <td class="col-status">
                  <span :class="['dot', `dot-${p.statusDot}`]" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="center-actions">
          <a :href="`/leaderboard/${sessionId}`" target="_blank" class="btn btn-ghost">Open Leaderboard ↗</a>
          <button class="btn btn-ghost-danger" @click="cancelGame">End Game</button>
        </div>
      </div>

      <!-- FINISHED -->
      <div v-if="phase === 'finished'" class="phase-finished">
        <div class="trophy-icon">🏆</div>
        <h1 class="section-title">Game Over</h1>

        <div class="card">
          <table v-if="sortedPlayers.length > 0" class="lb-table">
            <thead>
              <tr>
                <th class="col-rank">Rank</th>
                <th>Player</th>
                <th class="col-q">Questions</th>
                <th class="col-score">Score</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in sortedPlayers" :key="p.participantId" :class="{ 'row-first': i === 0 }">
                <td class="col-rank">
                  <span v-if="i === 0" class="medal">🥇</span>
                  <span v-else-if="i === 1" class="medal">🥈</span>
                  <span v-else-if="i === 2" class="medal">🥉</span>
                  <span v-else class="rank-num">{{ i + 1 }}</span>
                </td>
                <td class="player-cell">{{ p.displayName }}</td>
                <td class="col-q mono">{{ p.currentQuestion }}</td>
                <td class="col-score mono score-val">{{ p.score }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="center-actions">
          <button class="btn btn-gold btn-lg" @click="newGame">New Game</button>
        </div>
      </div>

      <!-- CANCELLED -->
      <div v-if="phase === 'cancelled'" class="phase-cancelled">
        <div class="cancel-icon">✕</div>
        <h1 class="section-title">Cancelled</h1>
        <p class="phase-msg">The session was cancelled.</p>
        <div class="center-actions">
          <button class="btn btn-gold btn-lg" @click="newGame">New Game</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
   ADMIN VIEW — Host Control Panel
   ============================================================ */

.admin {
  min-height: 100svh;
  position: relative;
  overflow: hidden;
}

.admin-inner {
  position: relative;
  z-index: 1;
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

/* ---- Ambient background ---- */

.bg-grid {
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(var(--border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
  background-size: 60px 60px;
  opacity: 0.4;
  pointer-events: none;
}

.bg-orb {
  position: fixed;
  border-radius: 50%;
  filter: blur(120px);
  pointer-events: none;
}

.bg-orb-gold {
  width: 500px;
  height: 500px;
  background: var(--gold);
  opacity: 0.04;
  top: -200px;
  right: -150px;
}

.bg-orb-cyan {
  width: 400px;
  height: 400px;
  background: var(--cyan);
  opacity: 0.03;
  bottom: -150px;
  left: -100px;
}

/* ---- Loading ---- */

.phase-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 50vh;
  gap: 16px;
}

.loader {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-medium);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.phase-msg {
  color: var(--text-secondary);
  font-size: 15px;
}

/* ---- Setup ---- */

.phase-setup {
  animation: slide-up 0.4s ease-out;
}

.setup-hero {
  text-align: center;
  margin-bottom: 32px;
}

.setup-title {
  font-size: 36px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--gold-light), var(--gold), #ef4444);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 8px;
}

.setup-sub {
  color: var(--text-secondary);
  font-size: 15px;
}

/* ---- Card ---- */

.card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 24px;
  box-shadow: var(--shadow-card);
}

.card-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ---- Form fields ---- */

.field {
  margin-bottom: 24px;
}

.field label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.select-wrap {
  position: relative;
}

.select-wrap select {
  width: 100%;
  padding: 12px 40px 12px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 15px;
  appearance: none;
  cursor: pointer;
  transition: border-color 0.2s;
}

.select-wrap select:focus {
  outline: none;
  border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

.select-arrow {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
  font-size: 14px;
}

/* ---- Toggle buttons ---- */

.toggle-row {
  display: flex;
  gap: 8px;
}

.toggle-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.toggle-btn:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.toggle-btn.active {
  background: var(--gold-subtle);
  border-color: var(--gold);
  color: var(--gold-light);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

.toggle-icon {
  font-size: 16px;
}

/* ---- Stepper ---- */

.stepper {
  display: inline-flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-input);
}

.stepper-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 18px;
  cursor: pointer;
  transition: all 0.15s;
}

.stepper-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.stepper-value {
  min-width: 80px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  border-inline: 1px solid var(--border-subtle);
  padding: 0 8px;
}

/* ---- Buttons ---- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: var(--radius-md);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  padding: 12px 28px;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-gold {
  background: linear-gradient(135deg, var(--gold), #d97706);
  color: #0c0a1a;
  box-shadow: 0 2px 12px var(--gold-glow);
}

.btn-gold:hover:not(:disabled) {
  box-shadow: var(--shadow-glow-gold);
  transform: translateY(-1px);
}

.btn-ghost {
  background: var(--bg-elevated);
  border: 1px solid var(--border-medium);
  color: var(--text-secondary);
}

.btn-ghost:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.btn-ghost-danger {
  background: transparent;
  border: 1px solid rgba(244, 63, 94, 0.3);
  color: var(--rose);
  padding: 10px 24px;
  font-size: 14px;
}

.btn-ghost-danger:hover {
  background: rgba(244, 63, 94, 0.08);
  border-color: var(--rose);
}

.btn-full { width: 100%; }
.btn-lg { padding: 16px 36px; font-size: 16px; border-radius: var(--radius-md); }
.btn-sm { padding: 8px 16px; font-size: 13px; }

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(12, 10, 26, 0.3);
  border-top-color: #0c0a1a;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.error-msg {
  color: var(--rose);
  font-size: 14px;
  margin-top: 12px;
  text-align: center;
}

/* ---- Lobby ---- */

.phase-lobby {
  animation: slide-up 0.4s ease-out;
}

.lobby-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.section-title {
  font-size: 28px;
  font-weight: 800;
}

.mono-badge {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  padding: 4px 10px;
  border-radius: var(--radius-full);
}

.lobby-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 24px;
}

@media (max-width: 600px) {
  .lobby-grid { grid-template-columns: 1fr; }
}

.qr-card {
  text-align: center;
}

.qr-frame {
  width: 200px;
  height: 200px;
  margin: 0 auto 12px;
  border: 2px solid var(--border-medium);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-input);
}

.qr-img {
  width: 180px;
  height: 180px;
}

.qr-url {
  font-size: 12px;
  margin-bottom: 12px;
  word-break: break-all;
}

.qr-url a {
  color: var(--cyan-light);
}

.players-card {
  display: flex;
  flex-direction: column;
}

.count-pill {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--gold-light);
  background: var(--gold-subtle);
  padding: 2px 10px;
  border-radius: var(--radius-full);
}

.empty-players {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  font-size: 14px;
}

.empty-pulse {
  width: 10px;
  height: 10px;
  background: var(--gold);
  border-radius: 50%;
  animation: pulse-glow 1.5s ease-in-out infinite;
}

.player-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
}

.player-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  animation: slide-up 0.3s ease-out both;
}

.player-avatar {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--violet), var(--cyan));
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}

.player-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.lobby-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
}

/* ---- Playing ---- */

.phase-playing {
  animation: slide-up 0.4s ease-out;
}

.playing-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.countdown-chip {
  font-size: 14px;
  color: var(--gold-light);
  background: var(--gold-subtle);
  border: 1px solid rgba(245, 158, 11, 0.3);
  padding: 6px 16px;
  border-radius: var(--radius-full);
}

.countdown-num {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 18px;
}

.live-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--rose);
  background: rgba(244, 63, 94, 0.08);
  border: 1px solid rgba(244, 63, 94, 0.3);
  padding: 6px 16px;
  border-radius: var(--radius-full);
}

.live-dot {
  width: 8px;
  height: 8px;
  background: var(--rose);
  border-radius: 50%;
  animation: pulse-glow 1s ease-in-out infinite;
}

.stats-row {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.stat-card {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 16px;
  text-align: center;
}

.stat-num {
  display: block;
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* ---- Leaderboard table ---- */

.lb-table {
  width: 100%;
  border-collapse: collapse;
}

.lb-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
}

.lb-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 14px;
  color: var(--text-primary);
}

.lb-table tr:last-child td {
  border-bottom: none;
}

.col-rank { width: 50px; text-align: center; }
.col-q { width: 60px; text-align: center; }
.col-score { width: 80px; text-align: right; }
.col-status { width: 40px; text-align: center; }

.rank-num {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--text-muted);
}

.row-first td {
  background: var(--gold-subtle);
}

.row-first .rank-num {
  color: var(--gold-light);
}

.mono {
  font-family: var(--font-mono);
}

.score-val {
  font-weight: 700;
  color: var(--emerald);
}

.player-cell {
  font-weight: 500;
}

.medal {
  font-size: 18px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.dot-green { background: var(--emerald); box-shadow: 0 0 6px var(--emerald-glow); }
.dot-amber { background: var(--gold); box-shadow: 0 0 6px var(--gold-glow); }
.dot-red { background: var(--rose); box-shadow: 0 0 6px var(--rose-glow); }
.dot-checkmark { background: var(--emerald); box-shadow: 0 0 6px var(--emerald-glow); }

.center-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}

/* ---- Finished / Cancelled ---- */

.phase-finished, .phase-cancelled {
  text-align: center;
  animation: slide-up 0.4s ease-out;
}

.trophy-icon {
  font-size: 64px;
  margin-bottom: 8px;
  animation: float 3s ease-in-out infinite;
}

.cancel-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 12px;
  border-radius: 50%;
  background: rgba(244, 63, 94, 0.1);
  border: 2px solid rgba(244, 63, 94, 0.3);
  color: var(--rose);
  font-size: 24px;
  font-weight: 700;
}

.phase-finished .card, .phase-cancelled .card {
  text-align: left;
  margin-top: 24px;
}

/* ---- Login ---- */

.phase-login {
  animation: slide-up 0.4s ease-out;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.login-form .field:last-of-type {
  margin-bottom: 20px;
}

.input {
  width: 100%;
  padding: 12px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 15px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
}

.input:focus {
  border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

/* ---- Create Category ---- */

.card-hint {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 14px;
}

.create-cat-row {
  display: flex;
  gap: 8px;
}

.cat-input {
  flex: 1;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.cat-input:focus {
  border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

.cat-input::placeholder {
  color: var(--text-muted);
}

.btn-cat {
  white-space: nowrap;
  padding: 10px 18px;
  font-size: 13px;
}

.spinner-sm {
  width: 14px;
  height: 14px;
  border-width: 2px;
}

.cat-status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.cat-status-generating {
  background: var(--gold-subtle);
  border: 1px solid rgba(245, 158, 11, 0.2);
  color: var(--gold-light);
}

.cat-status-created {
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  color: var(--emerald);
}

.cat-status-error {
  background: rgba(244, 63, 94, 0.06);
  border: 1px solid rgba(244, 63, 94, 0.2);
  color: var(--rose);
}

.cat-status-icon {
  flex-shrink: 0;
}

.cat-status-text {
  line-height: 1.4;
}
</style>