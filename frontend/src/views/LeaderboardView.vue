<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { subscribe } from '../appsync-events'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusDot = 'green' | 'amber' | 'red' | 'checkmark'
type GameStatus = 'waiting' | 'starting' | 'in_progress' | 'completed' | 'cancelled'

interface Player {
  participantId: string
  displayName: string
  status: string
  score: number
  currentQuestion: number
  statusDot: StatusDot
}

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

const route = useRoute()
const sessionId = route.params.sessionId as string

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const gameStatus = ref<GameStatus>('waiting')
const players = ref<Map<string, Player>>(new Map())
const questionCount = ref(0)
const mode = ref('')
const timeLimitMinutes = ref(0)
const startTime = ref<string | null>(null)
const countdown = ref<number | null>(null)
const showAllPlayers = ref(false)

const unsubscribes: (() => void)[] = []
let countdownInterval: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Computed — split into leader, top 10, and rest
// ---------------------------------------------------------------------------

const TOP_COUNT = 10

const sortedPlayers = computed(() => {
  return [...players.value.values()].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.displayName.localeCompare(b.displayName)
  })
})

const leader = computed(() => sortedPlayers.value[0] ?? null)

const topPlayers = computed(() => sortedPlayers.value.slice(0, TOP_COUNT))

const restPlayers = computed(() => sortedPlayers.value.slice(TOP_COUNT))

const totalPlayers = computed(() => players.value.size)

const completedCount = computed(() => {
  let count = 0
  for (const p of players.value.values()) {
    if (p.status === 'completed') count++
  }
  return count
})

const playingCount = computed(() => totalPlayers.value - completedCount.value)

const highScore = computed(() => leader.value?.score ?? 0)

const statusLabel = computed(() => {
  switch (gameStatus.value) {
    case 'waiting': return 'Waiting for Players'
    case 'starting': return countdown.value !== null ? `Starting in ${countdown.value}s` : 'Starting…'
    case 'in_progress': return 'Game In Progress'
    case 'completed': return 'Game Over!'
    case 'cancelled': return 'Game Cancelled'
    default: return ''
  }
})

const statusClass = computed(() => gameStatus.value)

// ---------------------------------------------------------------------------
// Status dot helpers
// ---------------------------------------------------------------------------

function dotClass(dot: StatusDot): string {
  switch (dot) {
    case 'green': return 'dot-green'
    case 'amber': return 'dot-amber'
    case 'red': return 'dot-red'
    case 'checkmark': return 'dot-check'
    default: return ''
  }
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------

function startCountdown(targetTime: string) {
  gameStatus.value = 'starting'
  startTime.value = targetTime

  const tick = () => {
    const diff = Math.max(0, Math.ceil((new Date(targetTime).getTime() - Date.now()) / 1000))
    countdown.value = diff
    if (diff <= 0) {
      if (countdownInterval) clearInterval(countdownInterval)
      countdownInterval = null
      gameStatus.value = 'in_progress'
      countdown.value = null
    }
  }

  tick()
  countdownInterval = setInterval(tick, 250)
}

// ---------------------------------------------------------------------------
// Leaderboard channel handler
// ---------------------------------------------------------------------------

function handleLeaderboardEvent(event: unknown) {
  const data = event as Record<string, unknown>
  switch (data.type) {
    case 'snapshot': handleSnapshot(data); break
    case 'player_list': handlePlayerList(data); break
    case 'player_update': handlePlayerUpdate(data); break
    case 'player_completed': handlePlayerCompleted(data); break
  }
}

function handleSnapshot(data: Record<string, unknown>) {
  if (data.status) gameStatus.value = data.status as GameStatus
  if (data.questionCount) questionCount.value = data.questionCount as number
  if (data.mode) mode.value = data.mode as string
  if (data.timeLimitMinutes) timeLimitMinutes.value = data.timeLimitMinutes as number

  const newPlayers = new Map<string, Player>()
  for (const p of (data.players as Array<Record<string, unknown>>) ?? []) {
    newPlayers.set(p.participantId as string, {
      participantId: p.participantId as string,
      displayName: p.displayName as string,
      status: (p.status as string) ?? 'waiting',
      score: (p.score as number) ?? 0,
      currentQuestion: (p.currentQuestion as number) ?? 0,
      statusDot: (p.statusDot as StatusDot) ?? 'green',
    })
  }
  players.value = newPlayers
}

function handlePlayerList(data: Record<string, unknown>) {
  const incoming = (data.players as Array<Record<string, unknown>>) ?? []
  const updated = new Map(players.value)
  for (const p of incoming) {
    const existing = updated.get(p.participantId as string)
    updated.set(p.participantId as string, {
      participantId: p.participantId as string,
      displayName: p.displayName as string,
      status: (p.status as string) ?? existing?.status ?? 'waiting',
      score: existing?.score ?? 0,
      currentQuestion: existing?.currentQuestion ?? 0,
      statusDot: existing?.statusDot ?? 'green',
    })
  }
  players.value = updated
}

function handlePlayerUpdate(data: Record<string, unknown>) {
  const pid = data.participantId as string
  const existing = players.value.get(pid)
  if (!existing) return
  const updated = new Map(players.value)
  updated.set(pid, {
    ...existing,
    score: (data.totalScore as number) ?? existing.score,
    currentQuestion: (data.currentQuestion as number) ?? existing.currentQuestion,
    statusDot: (data.statusDot as StatusDot) ?? existing.statusDot,
  })
  players.value = updated
}

function handlePlayerCompleted(data: Record<string, unknown>) {
  const pid = data.participantId as string
  const existing = players.value.get(pid)
  if (!existing) return
  const updated = new Map(players.value)
  updated.set(pid, { ...existing, status: 'completed', statusDot: 'checkmark' })
  players.value = updated
}

// ---------------------------------------------------------------------------
// Game channel handler
// ---------------------------------------------------------------------------

function handleGameEvent(event: unknown) {
  const data = event as Record<string, unknown>
  switch (data.type) {
    case 'game_started':
      if (data.startTime) startCountdown(data.startTime as string)
      break
    case 'times_up':
      gameStatus.value = 'completed'
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
      countdown.value = null
      break
    case 'game_cancelled':
      gameStatus.value = 'cancelled'
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
      countdown.value = null
      break
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  try {
    const unsubLeaderboard = await subscribe(`/leaderboard/${sessionId}`, handleLeaderboardEvent)
    unsubscribes.push(unsubLeaderboard)
    const unsubGame = await subscribe(`/game/${sessionId}`, handleGameEvent)
    unsubscribes.push(unsubGame)
  } catch (err) {
    console.error('[leaderboard] subscription error', err)
  }
})

onUnmounted(() => {
  for (const unsub of unsubscribes) unsub()
  if (countdownInterval) clearInterval(countdownInterval)
})
</script>

<template>
  <div class="lb">
    <!-- Ambient -->
    <div class="lb-grid" />
    <div class="lb-orb lb-orb-1" />
    <div class="lb-orb lb-orb-2" />

    <div class="lb-inner">
      <!-- Header bar -->
      <header class="lb-header">
        <div class="lb-brand">
          <span class="lb-brand-icon">?</span>
          <span class="lb-brand-text">Trivia Night</span>
        </div>
        <div :class="['status-chip', `status-${statusClass}`]">
          <span v-if="gameStatus === 'in_progress'" class="live-dot" />
          {{ statusLabel }}
        </div>
        <div class="session-mono">{{ sessionId.slice(0, 8) }}</div>
      </header>

      <!-- Countdown overlay -->
      <div v-if="gameStatus === 'starting' && countdown !== null" class="countdown-overlay">
        <div class="countdown-num">{{ countdown }}</div>
      </div>

      <!-- Game over banner -->
      <div v-if="gameStatus === 'completed'" class="banner banner-gold">
        <span class="banner-trophy">🏆</span> Game Over <span class="banner-trophy">🏆</span>
      </div>

      <!-- Cancelled banner -->
      <div v-if="gameStatus === 'cancelled'" class="banner banner-rose">
        Game Cancelled
      </div>

      <!-- Stats bar -->
      <div v-if="totalPlayers > 0" class="stats-bar">
        <div class="stat-pill">
          <span class="stat-num">{{ totalPlayers }}</span>
          <span class="stat-lbl">Players</span>
        </div>
        <div v-if="gameStatus === 'in_progress' || gameStatus === 'completed'" class="stat-pill">
          <span class="stat-num">{{ playingCount }}</span>
          <span class="stat-lbl">Playing</span>
        </div>
        <div v-if="gameStatus === 'in_progress' || gameStatus === 'completed'" class="stat-pill">
          <span class="stat-num">{{ completedCount }}</span>
          <span class="stat-lbl">Finished</span>
        </div>
        <div v-if="highScore > 0" class="stat-pill stat-pill-gold">
          <span class="stat-num">{{ highScore }}</span>
          <span class="stat-lbl">High Score</span>
        </div>
      </div>

      <!-- Podium — game over, 3+ players -->
      <div v-if="gameStatus === 'completed' && sortedPlayers.length >= 3" class="podium">
        <div class="podium-slot podium-2">
          <div class="podium-avatar podium-avatar-silver">{{ sortedPlayers[1].displayName.charAt(0).toUpperCase() }}</div>
          <div class="podium-name">{{ sortedPlayers[1].displayName }}</div>
          <div class="podium-score">{{ sortedPlayers[1].score }}</div>
          <div class="podium-bar podium-bar-2">2</div>
        </div>
        <div class="podium-slot podium-1">
          <div class="podium-crown">👑</div>
          <div class="podium-avatar podium-avatar-gold">{{ sortedPlayers[0].displayName.charAt(0).toUpperCase() }}</div>
          <div class="podium-name">{{ sortedPlayers[0].displayName }}</div>
          <div class="podium-score podium-score-gold">{{ sortedPlayers[0].score }}</div>
          <div class="podium-bar podium-bar-1">1</div>
        </div>
        <div class="podium-slot podium-3">
          <div class="podium-avatar podium-avatar-bronze">{{ sortedPlayers[2].displayName.charAt(0).toUpperCase() }}</div>
          <div class="podium-name">{{ sortedPlayers[2].displayName }}</div>
          <div class="podium-score">{{ sortedPlayers[2].score }}</div>
          <div class="podium-bar podium-bar-3">3</div>
        </div>
      </div>

      <!-- Leader hero — during gameplay, highlight #1 -->
      <div
        v-if="leader && gameStatus === 'in_progress' && totalPlayers > 1"
        class="leader-hero"
      >
        <div class="leader-avatar">{{ leader.displayName.charAt(0).toUpperCase() }}</div>
        <div class="leader-info">
          <div class="leader-label">Current Leader</div>
          <div class="leader-name">{{ leader.displayName }}</div>
        </div>
        <div class="leader-score">{{ leader.score }}</div>
      </div>

      <!-- Top 10 table -->
      <div v-if="topPlayers.length > 0" class="table-wrap">
        <div class="table-label">
          Top {{ Math.min(TOP_COUNT, totalPlayers) }}
          <span v-if="totalPlayers > TOP_COUNT" class="table-label-sub">of {{ totalPlayers }}</span>
        </div>
        <div class="table-header">
          <span class="th-rank">#</span>
          <span class="th-status"></span>
          <span class="th-name">Player</span>
          <span class="th-progress">Progress</span>
          <span class="th-score">Score</span>
        </div>

        <TransitionGroup name="row" tag="div" class="table-body">
          <div
            v-for="(player, index) in topPlayers"
            :key="player.participantId"
            :class="['table-row', { 'row-leader': index === 0 }]"
          >
            <span class="td-rank">
              <span v-if="index === 0" class="rank-medal">🥇</span>
              <span v-else-if="index === 1" class="rank-medal">🥈</span>
              <span v-else-if="index === 2" class="rank-medal">🥉</span>
              <span v-else class="rank-num">{{ index + 1 }}</span>
            </span>
            <span class="td-status">
              <span :class="['dot', dotClass(player.statusDot)]" />
            </span>
            <span class="td-name">{{ player.displayName }}</span>
            <span class="td-progress">
              Q{{ player.currentQuestion }}<span v-if="questionCount">/{{ questionCount }}</span>
            </span>
            <span class="td-score">{{ player.score }}</span>
          </div>
        </TransitionGroup>
      </div>

      <!-- Rest of players — collapsed by default -->
      <div v-if="restPlayers.length > 0" class="rest-section">
        <button class="rest-toggle" @click="showAllPlayers = !showAllPlayers">
          <span class="rest-toggle-text">
            {{ showAllPlayers ? 'Hide' : 'Show' }} remaining {{ restPlayers.length }} players
          </span>
          <span :class="['rest-arrow', { open: showAllPlayers }]">▾</span>
        </button>

        <div v-if="showAllPlayers" class="rest-list">
          <div
            v-for="(player, i) in restPlayers"
            :key="player.participantId"
            class="rest-row"
          >
            <span class="rest-rank">{{ i + TOP_COUNT + 1 }}</span>
            <span :class="['dot dot-sm', dotClass(player.statusDot)]" />
            <span class="rest-name">{{ player.displayName }}</span>
            <span class="rest-q">Q{{ player.currentQuestion }}</span>
            <span class="rest-score">{{ player.score }}</span>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="totalPlayers === 0" class="empty">
        <div class="empty-icon">📋</div>
        <p>Waiting for players to join…</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
   LEADERBOARD VIEW — Big-screen, 500-player scale
   ============================================================ */

.lb {
  min-height: 100vh;
  position: relative;
  overflow: hidden;
  background: var(--bg-deep);
}

.lb-inner {
  position: relative;
  z-index: 1;
  max-width: 960px;
  margin: 0 auto;
  padding: 2rem 2.5rem 3rem;
}

/* ---- Ambient ---- */

.lb-grid {
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(var(--border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
  background-size: 80px 80px;
  opacity: 0.3;
  pointer-events: none;
}

.lb-orb {
  position: fixed;
  border-radius: 50%;
  filter: blur(140px);
  pointer-events: none;
}

.lb-orb-1 {
  width: 600px;
  height: 600px;
  background: var(--gold);
  opacity: 0.04;
  top: -200px;
  left: -200px;
}

.lb-orb-2 {
  width: 500px;
  height: 500px;
  background: var(--cyan);
  opacity: 0.03;
  bottom: -200px;
  right: -150px;
}

/* ---- Header ---- */

.lb-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border-subtle);
}

.lb-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lb-brand-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--gold), #ef4444);
  border-radius: var(--radius-sm);
  font-family: Georgia, serif;
  font-size: 20px;
  font-weight: bold;
  color: #fff;
}

.lb-brand-text {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
}

.status-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding: 6px 18px;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border: 1px solid;
}

.status-waiting { color: var(--violet); border-color: rgba(139, 92, 246, 0.3); background: rgba(139, 92, 246, 0.08); }
.status-starting { color: var(--gold-light); border-color: rgba(245, 158, 11, 0.3); background: var(--gold-subtle); animation: pulse-glow 1s ease-in-out infinite; }
.status-in_progress { color: var(--emerald); border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.08); }
.status-completed { color: var(--gold-light); border-color: rgba(245, 158, 11, 0.3); background: var(--gold-subtle); }
.status-cancelled { color: var(--rose); border-color: rgba(244, 63, 94, 0.3); background: rgba(244, 63, 94, 0.08); }

.live-dot {
  width: 8px;
  height: 8px;
  background: var(--emerald);
  border-radius: 50%;
  animation: pulse-glow 1s ease-in-out infinite;
}

.session-mono {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

/* ---- Stats bar ---- */

.stats-bar {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
}

.stat-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
}

.stat-pill-gold {
  border-color: rgba(245, 158, 11, 0.2);
  background: var(--gold-subtle);
}

.stat-num {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-pill-gold .stat-num {
  color: var(--gold-light);
}

.stat-lbl {
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* ---- Countdown ---- */

.countdown-overlay {
  text-align: center;
  margin: 1rem 0 2rem;
}

.countdown-num {
  font-family: var(--font-mono);
  font-size: 10rem;
  font-weight: 700;
  line-height: 1;
  background: linear-gradient(135deg, var(--gold-light), var(--gold));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 60px var(--gold-glow));
  animation: count-pulse 1s ease-in-out infinite;
}

/* ---- Banners ---- */

.banner {
  text-align: center;
  font-size: 2.2rem;
  font-weight: 800;
  margin: 0.5rem 0 1.5rem;
  padding: 0.8rem;
  border-radius: var(--radius-lg);
}

.banner-gold {
  color: var(--gold-light);
  background: var(--gold-subtle);
  border: 1px solid rgba(245, 158, 11, 0.2);
  text-shadow: 0 0 30px var(--gold-glow);
}

.banner-rose {
  color: var(--rose);
  background: rgba(244, 63, 94, 0.06);
  border: 1px solid rgba(244, 63, 94, 0.2);
}

.banner-trophy { font-size: 1.8rem; }

/* ---- Leader hero (during gameplay) ---- */

.leader-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
  margin-bottom: 1.5rem;
  background: var(--gold-subtle);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-glow-gold);
  animation: slide-up 0.3s ease-out;
}

.leader-avatar {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--gold), #d97706);
  color: #fff;
  font-size: 20px;
  font-weight: 800;
  flex-shrink: 0;
  box-shadow: 0 0 20px var(--gold-glow);
}

.leader-info {
  flex: 1;
  min-width: 0;
}

.leader-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--gold);
  margin-bottom: 2px;
}

.leader-name {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.leader-score {
  font-family: var(--font-mono);
  font-size: 36px;
  font-weight: 700;
  color: var(--gold-light);
  flex-shrink: 0;
  text-shadow: 0 0 20px var(--gold-glow);
}

/* ---- Podium ---- */

.podium {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 16px;
  margin-bottom: 2rem;
  padding: 0 2rem;
  animation: slide-up 0.5s ease-out;
}

.podium-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 0 0 150px;
}

.podium-crown { font-size: 2rem; animation: float 2s ease-in-out infinite; }

.podium-avatar {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 20px;
  font-weight: 800;
  color: #fff;
}

.podium-avatar-gold {
  background: linear-gradient(135deg, var(--gold), #d97706);
  box-shadow: 0 0 24px var(--gold-glow);
  width: 60px;
  height: 60px;
  font-size: 24px;
}

.podium-avatar-silver {
  background: linear-gradient(135deg, #94a3b8, #64748b);
  box-shadow: 0 0 16px rgba(148, 163, 184, 0.2);
}

.podium-avatar-bronze {
  background: linear-gradient(135deg, #d97706, #92400e);
  box-shadow: 0 0 16px rgba(217, 119, 6, 0.2);
}

.podium-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.podium-score {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 700;
  color: var(--text-secondary);
}

.podium-score-gold { color: var(--gold-light); font-size: 22px; }

.podium-bar {
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 700;
  color: var(--text-muted);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-bottom: none;
  padding-bottom: 8px;
}

.podium-bar-1 { height: 100px; background: var(--gold-subtle); border-color: rgba(245, 158, 11, 0.2); color: var(--gold); }
.podium-bar-2 { height: 72px; }
.podium-bar-3 { height: 52px; }

/* ---- Top 10 table ---- */

.table-wrap {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-card);
  margin-bottom: 12px;
}

.table-label {
  padding: 12px 20px 0;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
}

.table-label-sub {
  color: var(--text-muted);
  opacity: 0.6;
}

.table-header {
  display: grid;
  grid-template-columns: 56px 40px 1fr 100px 90px;
  align-items: center;
  padding: 8px 20px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
}

.table-body { position: relative; }

.table-row {
  display: grid;
  grid-template-columns: 56px 40px 1fr 100px 90px;
  align-items: center;
  padding: 10px 20px;
  font-size: 1rem;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.2s;
}

.table-row:last-child { border-bottom: none; }

.row-leader {
  background: var(--gold-subtle);
}

.td-rank { text-align: center; }
.rank-medal { font-size: 1.2rem; }
.rank-num { font-family: var(--font-mono); font-weight: 700; color: var(--text-muted); }

.td-status { text-align: center; }

.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot-sm { width: 6px; height: 6px; }
.dot-green { background: var(--emerald); box-shadow: 0 0 6px var(--emerald-glow); }
.dot-amber { background: var(--gold); box-shadow: 0 0 6px var(--gold-glow); }
.dot-red { background: var(--rose); box-shadow: 0 0 6px var(--rose-glow); }
.dot-check { background: var(--emerald); box-shadow: 0 0 6px var(--emerald-glow); }

.td-name {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.td-progress {
  font-family: var(--font-mono);
  color: var(--text-muted);
  font-size: 0.85rem;
  text-align: center;
}

.td-score {
  font-family: var(--font-mono);
  font-weight: 800;
  font-size: 1.15rem;
  color: var(--emerald);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.row-leader .td-score { color: var(--gold-light); }

/* ---- Rest of players (expandable) ---- */

.rest-section {
  margin-top: 4px;
}

.rest-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.rest-toggle:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border-color: var(--border-medium);
}

.rest-arrow {
  transition: transform 0.2s;
  font-size: 12px;
}

.rest-arrow.open {
  transform: rotate(180deg);
}

.rest-list {
  margin-top: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  max-height: 400px;
  overflow-y: auto;
}

.rest-row {
  display: grid;
  grid-template-columns: 44px 20px 1fr 60px 70px;
  align-items: center;
  padding: 6px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-subtle);
}

.rest-row:last-child { border-bottom: none; }

.rest-rank {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-align: center;
}

.rest-name {
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rest-q {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.rest-score {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--emerald);
  text-align: right;
}

/* ---- Empty ---- */

.empty {
  text-align: center;
  margin-top: 8rem;
}

.empty-icon { font-size: 4rem; margin-bottom: 1rem; }
.empty p { font-size: 1.3rem; color: var(--text-muted); }

/* ---- Transitions ---- */

.row-move { transition: transform 0.4s ease; }
.row-enter-active { transition: all 0.3s ease; }
.row-leave-active { transition: all 0.25s ease; position: absolute; width: 100%; }
.row-enter-from { opacity: 0; transform: translateY(-8px); }
.row-leave-to { opacity: 0; transform: translateY(8px); }

/* ---- Responsive ---- */

@media (min-width: 1400px) {
  .lb-inner { max-width: 1100px; padding: 2.5rem 4rem; }
  .table-row { font-size: 1.15rem; padding: 12px 24px; }
  .td-score { font-size: 1.3rem; }
  .leader-name { font-size: 26px; }
  .leader-score { font-size: 42px; }
  .banner { font-size: 2.8rem; }
}

@media (max-width: 768px) {
  .lb-inner { padding: 1.5rem 1rem; }
  .table-header { grid-template-columns: 40px 32px 1fr 70px 60px; padding: 6px 12px; font-size: 9px; }
  .table-row { grid-template-columns: 40px 32px 1fr 70px 60px; padding: 8px 12px; font-size: 0.85rem; }
  .rest-row { grid-template-columns: 36px 18px 1fr 50px 56px; padding: 5px 10px; font-size: 12px; }
  .leader-hero { padding: 12px 16px; gap: 12px; }
  .leader-avatar { width: 40px; height: 40px; font-size: 16px; }
  .leader-name { font-size: 18px; }
  .leader-score { font-size: 28px; }
  .podium-slot { flex: 0 0 100px; }
  .podium-avatar { width: 40px; height: 40px; font-size: 16px; }
  .podium-avatar-gold { width: 48px; height: 48px; font-size: 20px; }
  .stats-bar { gap: 6px; }
  .stat-pill { padding: 4px 12px; }
}
</style>