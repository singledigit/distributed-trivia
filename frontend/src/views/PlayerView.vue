<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { subscribe, publish } from '../appsync-events'

// ---------------------------------------------------------------------------
// Route params
// ---------------------------------------------------------------------------

const route = useRoute()
const sessionId = route.params.sessionId as string

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type GamePhase =
  | 'join'
  | 'joining'
  | 'lobby'
  | 'countdown'
  | 'playing'
  | 'timeout'
  | 'feedback'
  | 'game_over'

const phase = ref<GamePhase>('join')
const displayName = ref('')
const nameError = ref('')
const participantId = ref('')
const questionCount = ref(0)

// Countdown
const countdownSeconds = ref(0)
let countdownInterval: ReturnType<typeof setInterval> | null = null

// Current question
const currentQuestion = ref<{
  questionNum: number
  totalQuestions: number
  questionText: string
  options: string[]
  difficulty: string
  points: number
  callbackToken: string
  currentScore: number
} | null>(null)

// Feedback
const lastAnswerCorrect = ref<boolean | null>(null)

// Timeout prompt
const timeoutCallbackToken = ref('')

// Last known callback token (for sending "complete" on game end)
const lastCallbackToken = ref('')

// Game complete
const finalScore = ref(0)
const questionsAnswered = ref(0)
const totalQuestions = ref(0)

// Ready callback token
const readyCallbackToken = ref('')

// Subscriptions
const unsubscribers: (() => void)[] = []

// ---------------------------------------------------------------------------
// Session storage helpers — each tab gets isolated state
// ---------------------------------------------------------------------------

// Use a per-tab key. On refresh, we want to restore. On new tab, we want fresh state.
// sessionStorage is copied on tab duplicate in some browsers, so we use a flag
// to detect if this is a genuine restore vs a duplicate.
const STORAGE_KEY = `trivia_player_${sessionId}`

interface StoredState {
  participantId: string
  displayName: string
  phase: GamePhase
  questionCount: number
  currentQuestion: typeof currentQuestion.value
  lastCallbackToken: string
  finalScore: number
  questionsAnswered: number
  totalQuestions: number
}

function saveState() {
  const state: StoredState = {
    participantId: participantId.value,
    displayName: displayName.value,
    phase: phase.value,
    questionCount: questionCount.value,
    currentQuestion: currentQuestion.value,
    lastCallbackToken: lastCallbackToken.value,
    finalScore: finalScore.value,
    questionsAnswered: questionsAnswered.value,
    totalQuestions: totalQuestions.value,
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function loadState(): StoredState | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredState
  } catch {
    return null
  }
}

function clearState() {
  sessionStorage.removeItem(STORAGE_KEY)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isNameValid = computed(() => {
  const trimmed = displayName.value.trim()
  return trimmed.length >= 1 && trimmed.length <= 20
})

function validateName() {
  const trimmed = displayName.value.trim()
  if (trimmed.length === 0) {
    nameError.value = 'Name is required'
    return false
  }
  if (trimmed.length > 20) {
    nameError.value = 'Name must be 20 characters or less'
    return false
  }
  nameError.value = ''
  return true
}

// ---------------------------------------------------------------------------
// Channel helpers
// ---------------------------------------------------------------------------

function playerChannel() {
  return `/player/${sessionId}/${participantId.value}`
}

function gameChannel() {
  return `/game/${sessionId}`
}

function joinChannel() {
  return `/player/${sessionId}/join`
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handlePlayerEvent(event: unknown) {
  const data = event as Record<string, unknown>
  const type = data.type as string

  switch (type) {
    case 'join_ack':
      questionCount.value = data.questionCount as number
      phase.value = 'lobby'
      saveState()
      break

    case 'game_starting':
      readyCallbackToken.value = data.callbackToken as string
      lastCallbackToken.value = data.callbackToken as string
      startCountdown(data.startTime as string)
      break

    case 'waiting_for_ready':
      // Legacy — now included in game_starting
      readyCallbackToken.value = data.callbackToken as string
      lastCallbackToken.value = data.callbackToken as string
      saveState()
      break

    case 'question':
      currentQuestion.value = {
        questionNum: data.questionNum as number,
        totalQuestions: data.totalQuestions as number,
        questionText: data.questionText as string,
        options: data.options as string[],
        difficulty: data.difficulty as string,
        points: data.points as number,
        callbackToken: data.callbackToken as string,
        currentScore: data.currentScore as number,
      }
      lastCallbackToken.value = data.callbackToken as string
      lastAnswerCorrect.value = null
      phase.value = 'playing'
      saveState()
      break

    case 'timeout_prompt':
      timeoutCallbackToken.value = data.callbackToken as string
      lastCallbackToken.value = data.callbackToken as string
      phase.value = 'timeout'
      saveState()
      break

    case 'game_complete':
      finalScore.value = data.totalScore as number
      questionsAnswered.value = data.questionsAnswered as number
      totalQuestions.value = data.totalQuestions as number
      phase.value = 'game_over'
      stopCountdown()
      saveState()
      break

    case 'error':
      console.error('[player] Error from server:', data.message)
      break
  }
}

function handleGameEvent(event: unknown) {
  const data = event as Record<string, unknown>
  const type = data.type as string

  switch (type) {
    case 'game_started':
      // Game started event from game channel — just a notification.
      // The actual countdown + callbackToken comes from game_starting on the player channel.
      // Only use this as fallback if we haven't received game_starting yet.
      if (phase.value === 'lobby' && !readyCallbackToken.value) {
        // Don't start countdown without a callback token — wait for game_starting
      }
      break

    case 'times_up':
    case 'game_cancelled':
      handleGameEnd()
      break
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleJoin() {
  if (!validateName()) return

  phase.value = 'joining'
  nameError.value = ''

  try {
    const myName = displayName.value.trim()

    // Subscribe to the join channel first to receive the response
    const joinUnsub = await subscribe(joinChannel(), (event: unknown) => {
      const data = event as Record<string, unknown>
      if (data.type === 'joined' && data.displayName === myName) {
        // This is OUR join response — match by display name
        participantId.value = data.participantId as string
        displayName.value = data.displayName as string
        saveState()
        // Unsubscribe from join channel — we don't need other players' join events
        joinUnsub()
        // Now subscribe to player + game channels
        subscribeToChannels()
      } else if (data.type === 'error') {
        nameError.value = data.message as string
        phase.value = 'join'
      }
    })
    unsubscribers.push(joinUnsub)

    // Publish join request
    await publish(joinChannel(), [
      { action: 'join', displayName: myName },
    ])
  } catch (err) {
    console.error('[player] Join failed:', err)
    nameError.value = 'Failed to join. Please try again.'
    phase.value = 'join'
  }
}

async function subscribeToChannels() {
  try {
    const playerUnsub = await subscribe(playerChannel(), handlePlayerEvent)
    unsubscribers.push(playerUnsub)

    const gameUnsub = await subscribe(gameChannel(), handleGameEvent)
    unsubscribers.push(gameUnsub)
  } catch (err) {
    console.error('[player] Subscribe failed:', err)
  }
}

function startCountdown(startTimeStr: string) {
  phase.value = 'countdown'
  stopCountdown()

  const startTime = new Date(startTimeStr).getTime()

  function tick() {
    const remaining = Math.max(0, Math.ceil((startTime - Date.now()) / 1000))
    countdownSeconds.value = remaining

    if (remaining <= 0) {
      stopCountdown()
      sendReady()
    }
  }

  tick()
  countdownInterval = setInterval(tick, 200)
  saveState()
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
}

async function sendReady() {
  if (!readyCallbackToken.value) {
    console.warn('[player] No ready callback token')
    return
  }
  try {
    await publish(playerChannel(), [
      { action: 'ready', callbackToken: readyCallbackToken.value },
    ])
    readyCallbackToken.value = ''
  } catch (err) {
    console.error('[player] Failed to send ready:', err)
  }
}

async function submitAnswer(option: string) {
  if (!currentQuestion.value) return

  const token = currentQuestion.value.callbackToken

  // Show brief feedback state
  phase.value = 'feedback'

  try {
    await publish(playerChannel(), [
      { action: 'answer', selectedOption: option, callbackToken: token },
    ])
  } catch (err) {
    console.error('[player] Failed to submit answer:', err)
    phase.value = 'playing'
  }
}

async function skipQuestion() {
  if (!currentQuestion.value) return

  const token = currentQuestion.value.callbackToken
  phase.value = 'feedback'

  try {
    await publish(playerChannel(), [
      { action: 'skip', callbackToken: token },
    ])
  } catch (err) {
    console.error('[player] Failed to skip:', err)
    phase.value = 'playing'
  }
}

async function requestMoreTime() {
  try {
    await publish(playerChannel(), [
      { action: 'more_time', callbackToken: timeoutCallbackToken.value },
    ])
  } catch (err) {
    console.error('[player] Failed to request more time:', err)
  }
}

async function skipFromTimeout() {
  try {
    await publish(playerChannel(), [
      { action: 'skip', callbackToken: timeoutCallbackToken.value },
    ])
  } catch (err) {
    console.error('[player] Failed to skip from timeout:', err)
  }
}

async function handleGameEnd() {
  // Send "complete" to POD using last known callback token
  if (lastCallbackToken.value && phase.value !== 'game_over') {
    try {
      await publish(playerChannel(), [
        { action: 'complete', callbackToken: lastCallbackToken.value },
      ])
    } catch (err) {
      console.error('[player] Failed to send complete:', err)
    }
  }
  // The game_complete event from POD will set the final score
}

// ---------------------------------------------------------------------------
// Computed helpers
// ---------------------------------------------------------------------------

const difficultyColor = computed(() => {
  if (!currentQuestion.value) return ''
  switch (currentQuestion.value.difficulty) {
    case 'easy': return '#22c55e'
    case 'medium': return '#f59e0b'
    case 'hard': return '#ef4444'
    default: return 'var(--text)'
  }
})

const progressPercent = computed(() => {
  if (!currentQuestion.value) return 0
  return Math.round(
    ((currentQuestion.value.questionNum - 1) / currentQuestion.value.totalQuestions) * 100,
  )
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  const stored = loadState()
  if (stored && stored.participantId) {
    // Restore state
    participantId.value = stored.participantId
    displayName.value = stored.displayName
    questionCount.value = stored.questionCount
    lastCallbackToken.value = stored.lastCallbackToken
    finalScore.value = stored.finalScore
    questionsAnswered.value = stored.questionsAnswered
    totalQuestions.value = stored.totalQuestions

    // Restore to a safe phase
    if (stored.phase === 'game_over') {
      phase.value = 'game_over'
    } else if (stored.phase === 'join' || stored.phase === 'joining') {
      phase.value = 'join'
      return
    } else {
      // Reconnect — go to lobby and wait for events
      phase.value = stored.phase === 'playing' || stored.phase === 'feedback'
        ? 'playing'
        : stored.phase
      if (stored.currentQuestion) {
        currentQuestion.value = stored.currentQuestion
      }
    }

    // Resubscribe to channels
    await subscribeToChannels()
  }
})

onUnmounted(() => {
  stopCountdown()
  for (const unsub of unsubscribers) {
    unsub()
  }
})

// Watch phase changes to persist
watch(phase, () => {
  if (participantId.value) {
    saveState()
  }
})
</script>

<template>
  <div class="player-view">
    <!-- Join Form -->
    <div v-if="phase === 'join' || phase === 'joining'" class="phase-join">
      <div class="logo-area">🎯</div>
      <h1>Join Trivia</h1>
      <p class="subtitle">Enter your name to join the game</p>

      <form class="join-form" @submit.prevent="handleJoin">
        <div class="input-group">
          <input
            v-model="displayName"
            type="text"
            placeholder="Your display name"
            maxlength="20"
            :disabled="phase === 'joining'"
            autofocus
            class="name-input"
          />
          <span class="char-count" :class="{ warn: displayName.trim().length > 17 }">
            {{ displayName.trim().length }}/20
          </span>
        </div>
        <p v-if="nameError" class="error">{{ nameError }}</p>
        <button
          type="submit"
          class="btn btn-primary btn-lg"
          :disabled="!isNameValid || phase === 'joining'"
        >
          <span v-if="phase === 'joining'" class="spinner" />
          {{ phase === 'joining' ? 'Joining...' : 'Join Game' }}
        </button>
      </form>
    </div>

    <!-- Lobby -->
    <div v-else-if="phase === 'lobby'" class="phase-lobby">
      <div class="logo-area">⏳</div>
      <h1>You're In!</h1>
      <p class="player-name">{{ displayName }}</p>
      <p class="subtitle">Waiting for the host to start the game...</p>
      <div v-if="questionCount" class="info-badge">
        {{ questionCount }} questions
      </div>
      <div class="pulse-dot" />
    </div>

    <!-- Countdown -->
    <div v-else-if="phase === 'countdown'" class="phase-countdown">
      <h1>Get Ready!</h1>
      <div class="countdown-number">{{ countdownSeconds }}</div>
      <p class="subtitle">Game starts in...</p>
    </div>

    <!-- Playing / Question -->
    <div v-else-if="phase === 'playing' && currentQuestion" class="phase-playing">
      <div class="question-header">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
        </div>
        <div class="question-meta">
          <span class="question-num">
            Q{{ currentQuestion.questionNum }}/{{ currentQuestion.totalQuestions }}
          </span>
          <span class="difficulty-badge" :style="{ background: difficultyColor }">
            {{ currentQuestion.difficulty }}
          </span>
          <span class="points-badge">{{ currentQuestion.points }} pts</span>
          <span class="score-badge">Score: {{ currentQuestion.currentScore }}</span>
        </div>
      </div>

      <div class="question-text">
        {{ currentQuestion.questionText }}
      </div>

      <div class="options-grid" :class="{ 'two-col': currentQuestion.options.length === 2 }">
        <button
          v-for="(option, idx) in currentQuestion.options"
          :key="idx"
          class="btn btn-option"
          :class="'option-' + idx"
          @click="submitAnswer(option)"
        >
          {{ option }}
        </button>
      </div>

      <button class="btn btn-skip" @click="skipQuestion">
        Skip →
      </button>
    </div>

    <!-- Feedback (brief) -->
    <div v-else-if="phase === 'feedback'" class="phase-feedback">
      <div class="feedback-icon">
        <span class="spinner" />
      </div>
      <p class="subtitle">Submitting answer...</p>
    </div>

    <!-- Timeout Prompt -->
    <div v-else-if="phase === 'timeout'" class="phase-timeout">
      <div class="timeout-icon">⏰</div>
      <h1>Time's Up!</h1>
      <p class="subtitle">What would you like to do?</p>
      <div class="timeout-actions">
        <button class="btn btn-primary" @click="requestMoreTime">
          More Time
        </button>
        <button class="btn btn-secondary" @click="skipFromTimeout">
          Skip
        </button>
      </div>
    </div>

    <!-- Game Over -->
    <div v-else-if="phase === 'game_over'" class="phase-game-over">
      <div class="logo-area">🏆</div>
      <h1>Game Over!</h1>
      <div class="final-score">
        <div class="score-value">{{ finalScore }}</div>
        <div class="score-label">points</div>
      </div>
      <div class="stats">
        <div class="stat">
          <span class="stat-value">{{ questionsAnswered }}</span>
          <span class="stat-label">answered</span>
        </div>
        <div class="stat-divider" />
        <div class="stat">
          <span class="stat-value">{{ totalQuestions }}</span>
          <span class="stat-label">total</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-view {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 20px;
  box-sizing: border-box;
}

/* ---- Common ---- */

.logo-area {
  font-size: 64px;
  margin-bottom: 8px;
}

h1 {
  font-size: 32px;
  margin: 0 0 8px;
}

.subtitle {
  color: var(--text);
  margin: 0 0 24px;
}

.error {
  color: #ef4444;
  font-size: 14px;
  margin: 4px 0 0;
}

/* ---- Buttons ---- */

.btn {
  border: none;
  border-radius: 12px;
  font-family: var(--sans);
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.2s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.btn:active {
  transform: scale(0.97);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
  padding: 14px 32px;
}

.btn-primary:hover:not(:disabled) {
  box-shadow: 0 4px 16px rgba(170, 59, 255, 0.35);
}

.btn-secondary {
  background: var(--accent-bg);
  color: var(--accent);
  padding: 14px 32px;
  border: 1px solid var(--accent-border);
}

.btn-lg {
  width: 100%;
  padding: 16px;
  font-size: 18px;
  border-radius: 12px;
}

.btn-option {
  background: var(--code-bg);
  color: var(--text-h);
  padding: 16px 20px;
  font-size: 16px;
  text-align: center;
  border: 2px solid var(--border);
  min-height: 56px;
}

.btn-option:hover {
  border-color: var(--accent-border);
  background: var(--accent-bg);
}

.option-0 { border-left: 4px solid #3b82f6; }
.option-1 { border-left: 4px solid #f59e0b; }
.option-2 { border-left: 4px solid #22c55e; }
.option-3 { border-left: 4px solid #ef4444; }

.btn-skip {
  background: transparent;
  color: var(--text);
  padding: 12px 24px;
  font-size: 14px;
  margin-top: 12px;
}

.btn-skip:hover {
  color: var(--text-h);
}

/* ---- Spinner ---- */

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  display: inline-block;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ---- Join Form ---- */

.phase-join {
  width: 100%;
  max-width: 400px;
  text-align: center;
}

.join-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.input-group {
  position: relative;
}

.name-input {
  width: 100%;
  padding: 14px 60px 14px 16px;
  font-size: 16px;
  font-family: var(--sans);
  border: 2px solid var(--border);
  border-radius: 12px;
  background: var(--bg);
  color: var(--text-h);
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.name-input:focus {
  border-color: var(--accent);
}

.char-count {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  color: var(--text);
  font-family: var(--mono);
}

.char-count.warn {
  color: #f59e0b;
}

/* ---- Lobby ---- */

.phase-lobby {
  text-align: center;
}

.player-name {
  font-size: 20px;
  font-weight: 600;
  color: var(--accent);
  margin: 0 0 4px;
}

.info-badge {
  display: inline-block;
  padding: 6px 16px;
  border-radius: 20px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 24px;
}

.pulse-dot {
  width: 12px;
  height: 12px;
  background: var(--accent);
  border-radius: 50%;
  margin: 0 auto;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}

/* ---- Countdown ---- */

.phase-countdown {
  text-align: center;
}

.countdown-number {
  font-size: 96px;
  font-weight: 700;
  font-family: var(--mono);
  color: var(--accent);
  line-height: 1;
  margin: 16px 0;
  animation: pulse 1s ease-in-out infinite;
}

/* ---- Playing ---- */

.phase-playing {
  width: 100%;
  max-width: 600px;
}

.question-header {
  margin-bottom: 24px;
}

.progress-bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 12px;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.question-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.question-num {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-h);
}

.difficulty-badge {
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  padding: 2px 10px;
  border-radius: 10px;
  text-transform: capitalize;
}

.points-badge {
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-bg);
  padding: 2px 10px;
  border-radius: 10px;
}

.score-badge {
  font-size: 13px;
  color: var(--text);
  margin-left: auto;
  font-family: var(--mono);
}

.question-text {
  font-size: 22px;
  font-weight: 500;
  color: var(--text-h);
  line-height: 1.4;
  margin-bottom: 24px;
}

.options-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.options-grid.two-col {
  grid-template-columns: 1fr;
  max-width: 400px;
  margin: 0 auto;
}

/* ---- Feedback ---- */

.phase-feedback {
  text-align: center;
}

.feedback-icon {
  margin-bottom: 16px;
}

.phase-feedback .spinner {
  width: 32px;
  height: 32px;
  border-color: var(--border);
  border-top-color: var(--accent);
}

/* ---- Timeout ---- */

.phase-timeout {
  text-align: center;
}

.timeout-icon {
  font-size: 64px;
  margin-bottom: 8px;
}

.timeout-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

/* ---- Game Over ---- */

.phase-game-over {
  text-align: center;
}

.final-score {
  margin: 24px 0;
}

.score-value {
  font-size: 72px;
  font-weight: 700;
  font-family: var(--mono);
  color: var(--accent);
  line-height: 1;
}

.score-label {
  font-size: 18px;
  color: var(--text);
  margin-top: 4px;
}

.stats {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  margin-bottom: 32px;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  color: var(--text-h);
  font-family: var(--mono);
}

.stat-label {
  font-size: 13px;
  color: var(--text);
}

.stat-divider {
  width: 1px;
  height: 40px;
  background: var(--border);
}

/* ---- Responsive ---- */

@media (max-width: 480px) {
  .options-grid {
    grid-template-columns: 1fr;
  }

  .question-text {
    font-size: 18px;
  }

  .countdown-number {
    font-size: 72px;
  }

  h1 {
    font-size: 28px;
  }
}
</style>
