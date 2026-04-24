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

// Cleanup handles
const unsubscribes: (() => void)[] = []
let countdownInterval: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const sortedPlayers = computed(() => {
  return [...players.value.values()].sort((a, b) => {
    // Completed players first, then by score descending
    if (a.score !== b.score) return b.score - a.score
    return a.displayName.localeCompare(b.displayName)
  })
})

const statusLabel = computed(() => {
  switch (gameStatus.value) {
    case 'waiting':
      return 'Waiting for Players'
    case 'starting':
      return countdown.value !== null ? `Starting in ${countdown.value}s` : 'Starting…'
    case 'in_progress':
      return 'Game In Progress'
    case 'completed':
      return 'Game Over!'
    case 'cancelled':
      return 'Game Cancelled'
    default:
      return ''
  }
})

const statusClass = computed(() => gameStatus.value)

// ---------------------------------------------------------------------------
// Status dot helpers
// ---------------------------------------------------------------------------

function dotEmoji(dot: StatusDot): string {
  switch (dot) {
    case 'green':
      return '🟢'
    case 'amber':
      return '🟡'
    case 'red':
      return '🔴'
    case 'checkmark':
      return '✅'
    default:
      return '⚪'
  }
}

function dotLabel(dot: StatusDot): string {
  switch (dot) {
    case 'green':
      return 'Correct'
    case 'amber':
      return 'Skip / More Time'
    case 'red':
      return 'Wrong'
    case 'checkmark':
      return 'Completed'
    default:
      return ''
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

function handleLeaderboardEvent(event: any) {
  const data = event as Record<string, any>

  switch (data.type) {
    case 'snapshot':
      handleSnapshot(data)
      break
    case 'player_list':
      handlePlayerList(data)
      break
    case 'player_update':
      handlePlayerUpdate(data)
      break
    case 'player_completed':
      handlePlayerCompleted(data)
      break
  }
}

function handleSnapshot(data: Record<string, any>) {
  // Restore full game state
  if (data.status) {
    gameStatus.value = data.status as GameStatus
  }
  if (data.questionCount) {
    questionCount.value = data.questionCount
  }
  if (data.mode) {
    mode.value = data.mode
  }
  if (data.timeLimitMinutes) {
    timeLimitMinutes.value = data.timeLimitMinutes
  }

  // Restore player list
  const newPlayers = new Map<string, Player>()
  for (const p of data.players ?? []) {
    newPlayers.set(p.participantId, {
      participantId: p.participantId,
      displayName: p.displayName,
      status: p.status ?? 'waiting',
      score: p.score ?? 0,
      currentQuestion: p.currentQuestion ?? 0,
      statusDot: (p.statusDot as StatusDot) ?? 'green',
    })
  }
  players.value = newPlayers
}

function handlePlayerList(data: Record<string, any>) {
  // Full player list update (on new player join)
  // Merge with existing data to preserve scores
  const incoming = data.players as Array<Record<string, any>> ?? []
  const updated = new Map(players.value)

  for (const p of incoming) {
    const existing = updated.get(p.participantId)
    updated.set(p.participantId, {
      participantId: p.participantId,
      displayName: p.displayName,
      status: p.status ?? existing?.status ?? 'waiting',
      score: existing?.score ?? 0,
      currentQuestion: existing?.currentQuestion ?? 0,
      statusDot: existing?.statusDot ?? 'green',
    })
  }
  players.value = updated
}

function handlePlayerUpdate(data: Record<string, any>) {
  const pid = data.participantId as string
  const existing = players.value.get(pid)
  if (!existing) return

  const updated = new Map(players.value)
  updated.set(pid, {
    ...existing,
    score: data.totalScore ?? existing.score,
    currentQuestion: data.currentQuestion ?? existing.currentQuestion,
    statusDot: (data.statusDot as StatusDot) ?? existing.statusDot,
  })
  players.value = updated
}

function handlePlayerCompleted(data: Record<string, any>) {
  const pid = data.participantId as string
  const existing = players.value.get(pid)
  if (!existing) return

  const updated = new Map(players.value)
  updated.set(pid, {
    ...existing,
    status: 'completed',
    statusDot: 'checkmark',
  })
  players.value = updated
}

// ---------------------------------------------------------------------------
// Game channel handler
// ---------------------------------------------------------------------------

function handleGameEvent(event: any) {
  const data = event as Record<string, any>

  switch (data.type) {
    case 'game_started':
      if (data.startTime) {
        startCountdown(data.startTime)
      }
      break
    case 'times_up':
      gameStatus.value = 'completed'
      if (countdownInterval) {
        clearInterval(countdownInterval)
        countdownInterval = null
      }
      countdown.value = null
      break
    case 'game_cancelled':
      gameStatus.value = 'cancelled'
      if (countdownInterval) {
        clearInterval(countdownInterval)
        countdownInterval = null
      }
      countdown.value = null
      break
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  try {
    const unsubLeaderboard = await subscribe(
      `/leaderboard/${sessionId}`,
      handleLeaderboardEvent,
    )
    unsubscribes.push(unsubLeaderboard)

    const unsubGame = await subscribe(
      `/game/${sessionId}`,
      handleGameEvent,
    )
    unsubscribes.push(unsubGame)
  } catch (err) {
    console.error('[leaderboard] subscription error', err)
  }
})

onUnmounted(() => {
  for (const unsub of unsubscribes) {
    unsub()
  }
  if (countdownInterval) {
    clearInterval(countdownInterval)
  }
})
</script>

<template>
  <div class="leaderboard-view">
    <!-- Status header -->
    <header class="status-header" :class="statusClass">
      <div class="status-badge">{{ statusLabel }}</div>
      <div class="session-id">Session {{ sessionId.slice(0, 8) }}</div>
    </header>

    <!-- Countdown overlay -->
    <div v-if="gameStatus === 'starting' && countdown !== null" class="countdown-overlay">
      <div class="countdown-number">{{ countdown }}</div>
    </div>

    <!-- Game over overlay -->
    <div v-if="gameStatus === 'completed'" class="game-over-banner">
      🏆 Game Over! 🏆
    </div>

    <!-- Cancelled overlay -->
    <div v-if="gameStatus === 'cancelled'" class="cancelled-banner">
      Game Cancelled
    </div>

    <!-- Player count -->
    <div class="player-count">
      {{ sortedPlayers.length }} Player{{ sortedPlayers.length !== 1 ? 's' : '' }}
    </div>

    <!-- Scoreboard table -->
    <div class="scoreboard" v-if="sortedPlayers.length > 0">
      <div class="scoreboard-header">
        <span class="col-rank">#</span>
        <span class="col-status"></span>
        <span class="col-name">Player</span>
        <span class="col-progress">Progress</span>
        <span class="col-score">Score</span>
      </div>

      <TransitionGroup name="player-row" tag="div" class="scoreboard-body">
        <div
          v-for="(player, index) in sortedPlayers"
          :key="player.participantId"
          class="player-row"
          :class="{ completed: player.statusDot === 'checkmark' }"
        >
          <span class="col-rank rank-number">{{ index + 1 }}</span>
          <span class="col-status" :title="dotLabel(player.statusDot)">
            {{ dotEmoji(player.statusDot) }}
          </span>
          <span class="col-name player-name">{{ player.displayName }}</span>
          <span class="col-progress question-progress">
            Q{{ player.currentQuestion }}<span v-if="questionCount">/{{ questionCount }}</span>
          </span>
          <span class="col-score player-score">{{ player.score }}</span>
        </div>
      </TransitionGroup>
    </div>

    <!-- Empty state -->
    <div v-else class="empty-state">
      <div class="empty-icon">📋</div>
      <p>Waiting for players to join…</p>
    </div>
  </div>
</template>

<style scoped>
.leaderboard-view {
  min-height: 100vh;
  background: #0f0f1a;
  color: #f0f0f5;
  font-family: system-ui, 'Segoe UI', Roboto, sans-serif;
  padding: 2rem 3rem;
  box-sizing: border-box;
}

/* ---- Status header ---- */

.status-header {
  text-align: center;
  margin-bottom: 1.5rem;
}

.status-badge {
  display: inline-block;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 0.5rem 2rem;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  border: 2px solid rgba(255, 255, 255, 0.15);
  transition: all 0.3s ease;
}

.status-header.waiting .status-badge {
  color: #a78bfa;
  border-color: rgba(167, 139, 250, 0.4);
  background: rgba(167, 139, 250, 0.1);
}

.status-header.starting .status-badge {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.4);
  background: rgba(251, 191, 36, 0.1);
  animation: pulse-glow 1s ease-in-out infinite;
}

.status-header.in_progress .status-badge {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(52, 211, 153, 0.1);
}

.status-header.completed .status-badge {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.4);
  background: rgba(251, 191, 36, 0.1);
}

.status-header.cancelled .status-badge {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.1);
}

.session-id {
  margin-top: 0.5rem;
  font-size: 0.9rem;
  color: #6b7280;
  font-family: ui-monospace, Consolas, monospace;
}

/* ---- Countdown ---- */

.countdown-overlay {
  text-align: center;
  margin: 1rem 0 2rem;
}

.countdown-number {
  font-size: 8rem;
  font-weight: 800;
  color: #fbbf24;
  text-shadow: 0 0 40px rgba(251, 191, 36, 0.5);
  line-height: 1;
  animation: pulse-scale 1s ease-in-out infinite;
}

/* ---- Game over / cancelled banners ---- */

.game-over-banner {
  text-align: center;
  font-size: 3rem;
  font-weight: 800;
  color: #fbbf24;
  margin: 1rem 0 2rem;
  text-shadow: 0 0 30px rgba(251, 191, 36, 0.4);
}

.cancelled-banner {
  text-align: center;
  font-size: 2.5rem;
  font-weight: 700;
  color: #f87171;
  margin: 1rem 0 2rem;
  text-shadow: 0 0 30px rgba(248, 113, 113, 0.3);
}

/* ---- Player count ---- */

.player-count {
  text-align: center;
  font-size: 1.1rem;
  color: #9ca3af;
  margin-bottom: 1.5rem;
}

/* ---- Scoreboard ---- */

.scoreboard {
  max-width: 900px;
  margin: 0 auto;
}

.scoreboard-header {
  display: grid;
  grid-template-columns: 60px 50px 1fr 120px 100px;
  align-items: center;
  padding: 0.75rem 1.5rem;
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #6b7280;
  border-bottom: 2px solid rgba(255, 255, 255, 0.08);
}

.scoreboard-body {
  position: relative;
}

.player-row {
  display: grid;
  grid-template-columns: 60px 50px 1fr 120px 100px;
  align-items: center;
  padding: 1rem 1.5rem;
  font-size: 1.4rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  transition: background 0.3s ease, transform 0.3s ease;
}

.player-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.player-row.completed {
  opacity: 0.85;
}

.rank-number {
  font-weight: 700;
  color: #a78bfa;
  font-size: 1.5rem;
}

.player-row:first-child .rank-number {
  color: #fbbf24;
  font-size: 1.8rem;
}

.player-row:nth-child(2) .rank-number {
  color: #d1d5db;
  font-size: 1.6rem;
}

.player-row:nth-child(3) .rank-number {
  color: #d97706;
  font-size: 1.6rem;
}

.col-status {
  font-size: 1.3rem;
  text-align: center;
}

.player-name {
  font-weight: 600;
  color: #f3f4f6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.question-progress {
  font-family: ui-monospace, Consolas, monospace;
  color: #9ca3af;
  font-size: 1.2rem;
  text-align: center;
}

.player-score {
  font-weight: 800;
  font-size: 1.6rem;
  color: #34d399;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ---- Empty state ---- */

.empty-state {
  text-align: center;
  margin-top: 6rem;
}

.empty-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
}

.empty-state p {
  font-size: 1.5rem;
  color: #6b7280;
}

/* ---- Animations ---- */

@keyframes pulse-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

@keyframes pulse-scale {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

/* TransitionGroup animations */
.player-row-move {
  transition: transform 0.5s ease;
}

.player-row-enter-active {
  transition: all 0.4s ease;
}

.player-row-leave-active {
  transition: all 0.3s ease;
  position: absolute;
  width: 100%;
}

.player-row-enter-from {
  opacity: 0;
  transform: translateX(-30px);
}

.player-row-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

/* ---- Responsive for very large screens ---- */

@media (min-width: 1400px) {
  .leaderboard-view {
    padding: 3rem 5rem;
  }

  .status-badge {
    font-size: 2.5rem;
  }

  .player-row {
    font-size: 1.6rem;
    padding: 1.2rem 2rem;
  }

  .player-score {
    font-size: 1.8rem;
  }

  .scoreboard {
    max-width: 1100px;
  }
}
</style>
