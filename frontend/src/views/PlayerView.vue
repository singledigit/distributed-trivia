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
  | 'reconnecting'
  | 'waiting_done'
  | 'game_over'

const phase = ref<GamePhase>('join')
const displayName = ref('')
const nameError = ref('')
const participantId = ref('')
const questionCount = ref(0)
const categoryName = ref('')
const categoryEmoji = ref('')
const categoryColor = ref('')
const gameMode = ref('')

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

// Last known callback token
const lastCallbackToken = ref('')

// Game complete
const finalScore = ref(0)
const questionsAnswered = ref(0)
const totalQuestions = ref(0)

// Post-game report
interface QuestionResult {
  questionNum: number
  questionText: string
  options: string[]
  correctAnswer: string
  difficulty: string
  points: number
  selectedOption: string | null
  isCorrect: boolean
  wasSkipped: boolean
}
const questionResults = ref<QuestionResult[]>([])
const showReport = ref(false)

// Ready callback token
const readyCallbackToken = ref('')

// Waiting-for-game-end callback token (when player finishes all questions before time)
const waitingEndCallbackToken = ref('')

// Subscriptions
const unsubscribers: (() => void)[] = []

// Timing
let joinStartTime = 0

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = `trivia_player_${sessionId}`

interface StoredState {
  participantId: string
  displayName: string
  phase: GamePhase
  questionCount: number
  categoryName: string
  categoryEmoji: string
  categoryColor: string
  currentQuestion: typeof currentQuestion.value
  lastCallbackToken: string
  finalScore: number
  questionsAnswered: number
  totalQuestions: number
  questionResults: QuestionResult[]
}

function saveState() {
  const state: StoredState = {
    participantId: participantId.value,
    displayName: displayName.value,
    phase: phase.value,
    questionCount: questionCount.value,
    categoryName: categoryName.value,
    categoryEmoji: categoryEmoji.value,
    categoryColor: categoryColor.value,
    currentQuestion: currentQuestion.value,
    lastCallbackToken: lastCallbackToken.value,
    finalScore: finalScore.value,
    questionsAnswered: questionsAnswered.value,
    totalQuestions: totalQuestions.value,
    questionResults: questionResults.value,
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function loadState(): StoredState | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as StoredState } catch { return null }
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
  if (trimmed.length === 0) { nameError.value = 'Name is required'; return false }
  if (trimmed.length > 20) { nameError.value = 'Name must be 20 characters or less'; return false }
  nameError.value = ''
  return true
}

// ---------------------------------------------------------------------------
// Channel helpers
// ---------------------------------------------------------------------------

function playerChannel() { return `/player/${sessionId}/${participantId.value}` }
function gameChannel() { return `/game/${sessionId}` }
function joinChannel() { return `/player/${sessionId}/join` }

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handlePlayerEvent(event: unknown) {
  const data = event as Record<string, unknown>
  const type = data.type as string

  switch (type) {
    case 'join_ack':
      if (joinStartTime) {
        console.log(`[timing] Join → Ack: ${Date.now() - joinStartTime}ms`)
        joinStartTime = 0
      }
      questionCount.value = data.questionCount as number
      categoryName.value = (data.categoryName as string) ?? ''
      categoryEmoji.value = (data.categoryEmoji as string) ?? ''
      categoryColor.value = (data.categoryColor as string) ?? ''
      gameMode.value = (data.mode as string) ?? ''
      phase.value = 'lobby'
      saveState()
      break
    case 'game_starting':
      readyCallbackToken.value = data.callbackToken as string
      lastCallbackToken.value = data.callbackToken as string
      startCountdown(data.startTime as string)
      break
    case 'waiting_for_ready':
      readyCallbackToken.value = data.callbackToken as string
      lastCallbackToken.value = data.callbackToken as string
      saveState()
      break
    case 'question':
      clearFeedbackTimeout()
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
      clearFeedbackTimeout()
      timeoutCallbackToken.value = data.callbackToken as string
      lastCallbackToken.value = data.callbackToken as string
      phase.value = 'timeout'
      saveState()
      break
    case 'game_complete':
      clearFeedbackTimeout()
      finalScore.value = data.totalScore as number
      questionsAnswered.value = data.questionsAnswered as number
      totalQuestions.value = data.totalQuestions as number
      questionResults.value = (data.questionResults as QuestionResult[]) ?? []
      phase.value = 'game_over'
      stopCountdown()
      saveState()
      break

    case 'all_questions_answered':
      clearFeedbackTimeout()
      finalScore.value = data.totalScore as number
      questionsAnswered.value = data.questionsAnswered as number
      totalQuestions.value = data.totalQuestions as number
      questionResults.value = (data.questionResults as QuestionResult[]) ?? []
      phase.value = 'waiting_done'
      saveState()
      break

    case 'waiting_for_game_end':
      waitingEndCallbackToken.value = data.callbackToken as string
      lastCallbackToken.value = data.callbackToken as string
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
      if (phase.value === 'lobby' && !readyCallbackToken.value) { /* wait for game_starting */ }
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
  joinStartTime = Date.now()

  const myName = displayName.value.trim()
  let joined = false
  let joinUnsub: (() => void) | null = null

  try {
    // Subscribe to join channel to receive the response
    joinUnsub = await subscribe(joinChannel(), (event: unknown) => {
      const data = event as Record<string, unknown>
      if (data.type === 'joined' && data.displayName === myName) {
        joined = true
        participantId.value = data.participantId as string
        displayName.value = data.displayName as string
        saveState()
        if (joinUnsub) joinUnsub()
        joinUnsub = null
        subscribeToChannels()
      } else if (data.type === 'error') {
        joined = true // stop retrying
        nameError.value = data.message as string
        phase.value = 'join'
      }
    })
    unsubscribers.push(() => { if (joinUnsub) joinUnsub() })

    // Publish join request with retry — up to 3 attempts, 3s apart
    for (let attempt = 1; attempt <= 3 && !joined; attempt++) {
      await publish(joinChannel(), [{ action: 'join', displayName: myName }])

      // Wait up to 5s for the join_ack
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => resolve(), 5000)
        const check = setInterval(() => {
          if (joined || phase.value === 'lobby' || phase.value === 'join') {
            clearTimeout(timeout)
            clearInterval(check)
            resolve()
          }
        }, 200)
      })

      if (!joined && attempt < 3) {
        console.log(`[player] Join attempt ${attempt} timed out, retrying...`)
      }
    }

    if (!joined && phase.value === 'joining') {
      nameError.value = 'Could not connect. Please try again.'
      phase.value = 'join'
    }
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
    if (remaining <= 0) { stopCountdown(); sendReady() }
  }
  tick()
  countdownInterval = setInterval(tick, 200)
  saveState()
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
}

async function sendReady() {
  if (!readyCallbackToken.value) return
  try {
    await publish(playerChannel(), [{ action: 'ready', callbackToken: readyCallbackToken.value }])
    readyCallbackToken.value = ''
  } catch (err) { console.error('[player] Failed to send ready:', err) }
}

let feedbackTimer: ReturnType<typeof setTimeout> | null = null

function startFeedbackTimeout() {
  clearFeedbackTimeout()
  feedbackTimer = setTimeout(() => {
    // No response after 8s — enter reconnecting state and wait for POD to catch up
    if (phase.value === 'feedback') {
      console.warn('[player] Feedback timeout — waiting for POD to send next event')
      phase.value = 'reconnecting'
    }
  }, 8000)
}

function clearFeedbackTimeout() {
  if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = null }
}

async function submitAnswer(option: string) {
  if (!currentQuestion.value) return
  const token = currentQuestion.value.callbackToken
  phase.value = 'feedback'
  startFeedbackTimeout()
  try {
    await publish(playerChannel(), [{ action: 'answer', selectedOption: option, callbackToken: token }])
  } catch (err) { console.error('[player] Failed to submit answer:', err); clearFeedbackTimeout(); phase.value = 'playing' }
}

async function skipQuestion() {
  if (!currentQuestion.value) return
  const token = currentQuestion.value.callbackToken
  phase.value = 'feedback'
  startFeedbackTimeout()
  try {
    await publish(playerChannel(), [{ action: 'skip', callbackToken: token }])
  } catch (err) { console.error('[player] Failed to skip:', err); clearFeedbackTimeout(); phase.value = 'playing' }
}

async function requestMoreTime() {
  try {
    await publish(playerChannel(), [{ action: 'more_time', callbackToken: timeoutCallbackToken.value }])
  } catch (err) { console.error('[player] Failed to request more time:', err) }
}

async function skipFromTimeout() {
  try {
    await publish(playerChannel(), [{ action: 'skip', callbackToken: timeoutCallbackToken.value }])
  } catch (err) { console.error('[player] Failed to skip from timeout:', err) }
}

async function handleGameEnd() {
  // Send "complete" to POD using the appropriate callback token
  const token = waitingEndCallbackToken.value || lastCallbackToken.value
  if (token && phase.value !== 'game_over') {
    try {
      await publish(playerChannel(), [{ action: 'complete', callbackToken: token }])
    } catch (err) { console.error('[player] Failed to send complete:', err) }
  }
}

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const difficultyLabel = computed(() => currentQuestion.value?.difficulty ?? '')
const difficultyClass = computed(() => `diff-${currentQuestion.value?.difficulty ?? 'easy'}`)

const progressPercent = computed(() => {
  if (!currentQuestion.value) return 0
  return Math.round(((currentQuestion.value.questionNum - 1) / currentQuestion.value.totalQuestions) * 100)
})

// Report computed
const correctCount = computed(() => questionResults.value.filter(r => r.isCorrect).length)
const incorrectCount = computed(() => questionResults.value.filter(r => !r.isCorrect && !r.wasSkipped).length)
const skippedCount = computed(() => questionResults.value.filter(r => r.wasSkipped).length)

// Category theme — use backend emoji if available, fall back to keyword matching
const categoryTheme = computed(() => {
  // Prefer emoji from backend (set by Category Creator ODF)
  if (categoryEmoji.value) {
    return { emoji: categoryEmoji.value, label: categoryName.value || 'Trivia' }
  }

  // Fallback: keyword matching for legacy categories without stored emoji
  const name = categoryName.value.toLowerCase()
  if (name.includes('star wars')) return { emoji: '⚔️', label: 'Star Wars' }
  if (name.includes('harry potter') || name.includes('hogwarts')) return { emoji: '⚡', label: 'Harry Potter' }
  if (name.includes('disney')) return { emoji: '🏰', label: 'Disney' }
  if (name.includes('marvel') || name.includes('avenger')) return { emoji: '🦸', label: 'Marvel' }
  if (name.includes('music') || name.includes('80s') || name.includes('90s') || name.includes('hip hop')) return { emoji: '🎵', label: categoryName.value }
  if (name.includes('science') || name.includes('nature')) return { emoji: '🔬', label: 'Science' }
  if (name.includes('space') || name.includes('astro')) return { emoji: '🚀', label: 'Space' }
  if (name.includes('history') || name.includes('war')) return { emoji: '📜', label: 'History' }
  if (name.includes('sport')) return { emoji: '⚽', label: 'Sports' }
  if (name.includes('food') || name.includes('cook') || name.includes('cuisine')) return { emoji: '🍳', label: 'Food' }
  if (name.includes('geo') || name.includes('countr') || name.includes('capital')) return { emoji: '🌍', label: 'Geography' }
  if (name.includes('bible') || name.includes('religio')) return { emoji: '📖', label: 'Bible' }
  if (name.includes('movie') || name.includes('film') || name.includes('cinema')) return { emoji: '🎬', label: 'Movies' }
  if (name.includes('tv') || name.includes('television') || name.includes('series')) return { emoji: '📺', label: 'TV' }
  if (name.includes('game') || name.includes('video game') || name.includes('gaming')) return { emoji: '🎮', label: 'Gaming' }
  if (name.includes('aws') || name.includes('cloud') || name.includes('architect')) return { emoji: '☁️', label: 'AWS' }
  if (name.includes('animal') || name.includes('wildlife')) return { emoji: '🐾', label: 'Animals' }
  if (name.includes('art') || name.includes('paint')) return { emoji: '🎨', label: 'Art' }
  if (name.includes('book') || name.includes('literature')) return { emoji: '📚', label: 'Literature' }
  return { emoji: '🧠', label: categoryName.value || 'Trivia' }
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  const stored = loadState()
  if (stored && stored.participantId) {
    participantId.value = stored.participantId
    displayName.value = stored.displayName
    questionCount.value = stored.questionCount
    categoryName.value = stored.categoryName ?? ''
    categoryEmoji.value = stored.categoryEmoji ?? ''
    categoryColor.value = stored.categoryColor ?? ''
    lastCallbackToken.value = stored.lastCallbackToken
    finalScore.value = stored.finalScore
    questionsAnswered.value = stored.questionsAnswered
    totalQuestions.value = stored.totalQuestions
    questionResults.value = stored.questionResults ?? []

    if (stored.phase === 'game_over') {
      phase.value = 'game_over'
    } else if (stored.phase === 'waiting_done') {
      phase.value = 'waiting_done'
    } else if (stored.phase === 'join' || stored.phase === 'joining') {
      phase.value = 'join'
      return
    } else if (stored.phase === 'playing' && stored.currentQuestion) {
      // Restore to the question — token may still be valid
      currentQuestion.value = stored.currentQuestion
      phase.value = 'playing'
    } else if (stored.phase === 'feedback' && stored.currentQuestion) {
      // Was submitting an answer — show the question, let them re-submit if token is still valid
      currentQuestion.value = stored.currentQuestion
      phase.value = 'playing'
    } else {
      // lobby, countdown, timeout, reconnecting — restore as-is
      phase.value = stored.phase
      if (stored.currentQuestion) currentQuestion.value = stored.currentQuestion
    }
    await subscribeToChannels()
  }
})

onUnmounted(() => {
  stopCountdown()
  clearFeedbackTimeout()
  for (const unsub of unsubscribers) unsub()
})

watch(phase, () => { if (participantId.value) saveState() })
</script>

<template>
  <div class="player" :style="categoryColor ? { '--cat-color': categoryColor, '--cat-glow': categoryColor + '40', '--cat-bg': categoryColor + '0a', '--cat-border': categoryColor + '30' } : {}">
    <div class="bg-wash" />
    <div class="bg-orb bg-orb-1" />
    <div class="bg-orb bg-orb-2" />

    <div class="player-inner">
      <!-- JOIN -->
      <div v-if="phase === 'join' || phase === 'joining'" class="phase-join">
        <div class="join-brand">
          <div class="brand-icon">?</div>
          <h1 class="brand-title">Trivia Night</h1>
        </div>
        <p class="join-sub">Enter your name to play</p>

        <form class="join-form" @submit.prevent="handleJoin">
          <div class="input-wrap">
            <input
              v-model="displayName"
              type="text"
              placeholder="Your name"
              maxlength="20"
              :disabled="phase === 'joining'"
              autofocus
              class="name-input"
            />
            <span class="char-count" :class="{ warn: displayName.trim().length > 17 }">
              {{ displayName.trim().length }}/20
            </span>
          </div>
          <p v-if="nameError" class="error-msg">{{ nameError }}</p>
          <button type="submit" class="btn btn-gold btn-full btn-lg" :disabled="!isNameValid || phase === 'joining'">
            <span v-if="phase === 'joining'" class="spinner" />
            {{ phase === 'joining' ? 'Joining…' : 'Join Game' }}
          </button>
        </form>
      </div>

      <!-- LOBBY -->
      <div v-else-if="phase === 'lobby'" class="phase-lobby">
        <div class="lobby-icon">✓</div>
        <h1>You're In!</h1>
        <p class="player-display-name">{{ displayName }}</p>
        <p class="lobby-sub">Waiting for the host to start…</p>
        <div class="lobby-category" v-if="categoryName">
          <span class="cat-emoji">{{ categoryTheme.emoji }}</span>
          <span>{{ categoryName }}</span>
        </div>
        <div v-if="questionCount && gameMode !== 'timed'" class="info-pill">{{ questionCount }} questions</div>
        <div class="waiting-dots">
          <span /><span /><span />
        </div>
      </div>

      <!-- COUNTDOWN -->
      <div v-else-if="phase === 'countdown'" class="phase-countdown">
        <p class="countdown-label">Get Ready</p>
        <div class="countdown-big">{{ countdownSeconds }}</div>
      </div>

      <!-- PLAYING -->
      <div v-else-if="phase === 'playing' && currentQuestion" class="phase-playing">
        <div class="q-header">
          <div v-if="gameMode !== 'timed'" class="progress-track">
            <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
          </div>
          <div class="q-meta">
            <span v-if="categoryTheme.emoji" class="q-cat-emoji">{{ categoryTheme.emoji }}</span>
            <span class="q-num">{{ gameMode === 'timed' ? `Q${currentQuestion.questionNum}` : `${currentQuestion.questionNum}/${currentQuestion.totalQuestions}` }}</span>
            <span :class="['diff-pill', difficultyClass]">{{ difficultyLabel }}</span>
            <span class="pts-pill">{{ currentQuestion.points }} pts</span>
            <span class="score-pill">{{ currentQuestion.currentScore }}</span>
          </div>
        </div>

        <div class="q-text">{{ currentQuestion.questionText }}</div>

        <div class="options" :class="{ 'options-two': currentQuestion.options.length === 2 }">
          <button
            v-for="(option, idx) in currentQuestion.options"
            :key="idx"
            :class="['opt-btn']"
            @click="submitAnswer(option)"
          >
            <span class="opt-letter">{{ String.fromCharCode(65 + idx) }}</span>
            <span class="opt-text">{{ option }}</span>
          </button>
        </div>

        <button class="skip-btn" @click="skipQuestion">Skip →</button>
      </div>

      <!-- FEEDBACK -->
      <div v-else-if="phase === 'feedback'" class="phase-feedback">
        <div class="feedback-loader" />
        <p class="feedback-text">Submitting…</p>
      </div>

      <!-- RECONNECTING — waiting for POD to send next event -->
      <div v-else-if="phase === 'reconnecting'" class="phase-reconnecting">
        <div class="reconnect-icon">📡</div>
        <h1>Catching up…</h1>
        <p class="reconnect-sub">Waiting for the next question</p>
        <div class="waiting-dots">
          <span /><span /><span />
        </div>
      </div>

      <!-- TIMEOUT -->
      <div v-else-if="phase === 'timeout'" class="phase-timeout">
        <div class="timeout-icon">⏰</div>
        <h1>Time's Up!</h1>
        <p class="timeout-sub">What would you like to do?</p>
        <div class="timeout-actions">
          <button class="btn btn-gold" @click="requestMoreTime">More Time</button>
          <button class="btn btn-ghost" @click="skipFromTimeout">Skip</button>
        </div>
      </div>

      <!-- WAITING DONE — finished all questions, waiting for game to end -->
      <div v-else-if="phase === 'waiting_done'" class="phase-waiting-done">
        <div class="wd-icon">✅</div>
        <h1>All Done!</h1>
        <div class="wd-score">
          <span class="wd-score-num">{{ finalScore }}</span>
          <span class="wd-score-label">points</span>
        </div>
        <p class="wd-sub">Waiting for the game to end…</p>
        <div class="waiting-dots">
          <span /><span /><span />
        </div>

        <!-- Preview report while waiting -->
        <div v-if="questionResults.length > 0" class="report-summary" style="margin-top: 32px;">
          <div class="report-pills">
            <span class="rpill rpill-correct">{{ correctCount }} correct</span>
            <span class="rpill rpill-wrong">{{ incorrectCount }} wrong</span>
            <span v-if="skippedCount > 0" class="rpill rpill-skip">{{ skippedCount }} skipped</span>
          </div>
          <button class="btn-report" @click="showReport = !showReport">
            {{ showReport ? 'Hide' : 'Review' }} Answers
            <span :class="['report-arrow', { open: showReport }]">▾</span>
          </button>
        </div>

        <div v-if="showReport && questionResults.length > 0" class="report">
          <div
            v-for="r in questionResults"
            :key="r.questionNum"
            :class="['report-item', { 'ri-correct': r.isCorrect, 'ri-wrong': !r.isCorrect && !r.wasSkipped, 'ri-skip': r.wasSkipped }]"
          >
            <div class="ri-header">
              <span class="ri-num">Q{{ r.questionNum }}</span>
              <span :class="['ri-badge', `ri-badge-${r.difficulty}`]">{{ r.difficulty }}</span>
              <span class="ri-pts">{{ r.points }} pts</span>
              <span class="ri-result">
                <span v-if="r.isCorrect">✓</span>
                <span v-else-if="r.wasSkipped">—</span>
                <span v-else>✗</span>
              </span>
            </div>
            <div class="ri-question">{{ r.questionText }}</div>
            <div v-if="!r.isCorrect" class="ri-answer">
              <span v-if="r.selectedOption" class="ri-yours">Your answer: {{ r.selectedOption }}</span>
              <span v-else class="ri-yours">Skipped</span>
              <span class="ri-correct-answer">Correct: {{ r.correctAnswer }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- GAME OVER -->
      <div v-else-if="phase === 'game_over'" class="phase-gameover">
        <div class="go-trophy">🏆</div>
        <h1>Game Over!</h1>
        <div class="go-score">
          <span class="go-score-num">{{ finalScore }}</span>
          <span class="go-score-label">points</span>
        </div>
        <div class="go-stats">
          <div class="go-stat">
            <span class="go-stat-num">{{ questionsAnswered }}</span>
            <span class="go-stat-label">answered</span>
          </div>
          <div class="go-divider" />
          <div class="go-stat">
            <span class="go-stat-num">{{ totalQuestions }}</span>
            <span class="go-stat-label">total</span>
          </div>
        </div>

        <!-- Report summary -->
        <div v-if="questionResults.length > 0" class="report-summary">
          <div class="report-pills">
            <span class="rpill rpill-correct">{{ correctCount }} correct</span>
            <span class="rpill rpill-wrong">{{ incorrectCount }} wrong</span>
            <span v-if="skippedCount > 0" class="rpill rpill-skip">{{ skippedCount }} skipped</span>
          </div>
          <button class="btn-report" @click="showReport = !showReport">
            {{ showReport ? 'Hide' : 'Review' }} Answers
            <span :class="['report-arrow', { open: showReport }]">▾</span>
          </button>
        </div>

        <!-- Detailed report -->
        <div v-if="showReport && questionResults.length > 0" class="report">
          <div
            v-for="r in questionResults"
            :key="r.questionNum"
            :class="['report-item', { 'ri-correct': r.isCorrect, 'ri-wrong': !r.isCorrect && !r.wasSkipped, 'ri-skip': r.wasSkipped }]"
          >
            <div class="ri-header">
              <span class="ri-num">Q{{ r.questionNum }}</span>
              <span :class="['ri-badge', `ri-badge-${r.difficulty}`]">{{ r.difficulty }}</span>
              <span class="ri-pts">{{ r.points }} pts</span>
              <span class="ri-result">
                <span v-if="r.isCorrect">✓</span>
                <span v-else-if="r.wasSkipped">—</span>
                <span v-else>✗</span>
              </span>
            </div>
            <div class="ri-question">{{ r.questionText }}</div>
            <div v-if="!r.isCorrect" class="ri-answer">
              <span v-if="r.selectedOption" class="ri-yours">Your answer: {{ r.selectedOption }}</span>
              <span v-else class="ri-yours">Skipped</span>
              <span class="ri-correct-answer">Correct: {{ r.correctAnswer }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
   PLAYER VIEW — Mobile-first game experience
   ============================================================ */

.player {
  min-height: 100svh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  padding: 24px 20px;
}

.player-inner {
  width: 100%;
  max-width: 480px;
  position: relative;
  z-index: 1;
}

.bg-orb {
  position: fixed;
  border-radius: 50%;
  filter: blur(120px);
  pointer-events: none;
}

.bg-orb-1 {
  width: 350px;
  height: 350px;
  background: var(--cat-color, var(--gold));
  opacity: 0.07;
  top: -120px;
  left: -80px;
}

.bg-orb-2 {
  width: 300px;
  height: 300px;
  background: var(--cat-color, var(--cyan));
  opacity: 0.05;
  bottom: -100px;
  right: -60px;
}

.bg-wash {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 300px;
  background: linear-gradient(180deg, var(--cat-bg, transparent) 0%, transparent 100%);
  pointer-events: none;
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
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  padding: 14px 32px;
}

.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-gold {
  background: var(--cat-color, linear-gradient(135deg, var(--gold), #d97706));
  color: #fff;
  box-shadow: 0 2px 16px var(--cat-glow, var(--gold-glow));
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
}

.btn-gold:hover:not(:disabled) {
  box-shadow: 0 0 30px var(--cat-glow, var(--gold-glow)), 0 0 60px color-mix(in srgb, var(--cat-color, var(--gold)) 15%, transparent);
  transform: translateY(-1px);
}

.btn-gold:active:not(:disabled) { transform: scale(0.97); }

.btn-ghost {
  background: var(--bg-elevated);
  border: 1px solid var(--border-medium);
  color: var(--text-secondary);
}

.btn-ghost:hover { border-color: var(--border-strong); color: var(--text-primary); }

.btn-full { width: 100%; }
.btn-lg { padding: 16px; font-size: 17px; border-radius: var(--radius-lg); }

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(12, 10, 26, 0.3);
  border-top-color: #0c0a1a;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.error-msg {
  color: var(--rose);
  font-size: 14px;
  margin-top: 4px;
  text-align: center;
}

/* ---- JOIN ---- */

.phase-join {
  text-align: center;
  animation: slide-up 0.5s ease-out;
}

.join-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.brand-icon {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--gold), #ef4444);
  border-radius: var(--radius-lg);
  font-family: Georgia, serif;
  font-size: 28px;
  font-weight: bold;
  color: #fff;
  box-shadow: var(--shadow-glow-gold);
}

.brand-title {
  font-size: 32px;
  font-weight: 800;
}

.join-sub {
  color: var(--text-secondary);
  margin-bottom: 32px;
}

.join-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.input-wrap {
  position: relative;
}

.name-input {
  width: 100%;
  padding: 16px 60px 16px 20px;
  background: var(--bg-card);
  border: 2px solid var(--border-medium);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 17px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
}

.name-input:focus {
  border-color: var(--cat-color, var(--gold));
  box-shadow: 0 0 0 4px var(--cat-glow, var(--gold-glow));
}

.name-input::placeholder {
  color: var(--text-muted);
}

.char-count {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
}

.char-count.warn { color: var(--gold); }

/* ---- LOBBY ---- */

.phase-lobby {
  text-align: center;
  animation: scale-in 0.4s ease-out;
}

.lobby-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
  border-radius: 50%;
  background: var(--cat-glow, var(--emerald-glow));
  border: 2px solid var(--cat-color, var(--emerald));
  color: var(--cat-color, var(--emerald));
  font-size: 28px;
  font-weight: 700;
}

.phase-lobby h1 {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 4px;
}

.player-display-name {
  font-size: 18px;
  font-weight: 600;
  color: var(--cat-color, var(--gold-light));
  margin-bottom: 4px;
}

.lobby-sub {
  color: var(--text-secondary);
  font-size: 15px;
  margin-bottom: 20px;
}

.info-pill {
  display: inline-block;
  padding: 6px 18px;
  border-radius: var(--radius-full);
  background: var(--cyan-subtle);
  border: 1px solid rgba(6, 182, 212, 0.3);
  color: var(--cyan-light);
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 24px;
}

.lobby-category {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--cat-color, var(--gold)) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--cat-color, var(--gold)) 25%, transparent);
  color: var(--cat-color, var(--gold-light));
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
}

.cat-emoji { font-size: 18px; }

.q-cat-emoji { font-size: 16px; }

.waiting-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
}

.waiting-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cat-color, var(--gold));
  animation: pulse-glow 1.4s ease-in-out infinite;
}

.waiting-dots span:nth-child(2) { animation-delay: 0.2s; }
.waiting-dots span:nth-child(3) { animation-delay: 0.4s; }

/* ---- COUNTDOWN ---- */

.phase-countdown {
  text-align: center;
  animation: scale-in 0.3s ease-out;
}

.countdown-label {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 2px;
  margin-bottom: 8px;
}

.countdown-big {
  font-family: var(--font-mono);
  font-size: 120px;
  font-weight: 700;
  line-height: 1;
  color: var(--cat-color, var(--gold-light));
  filter: drop-shadow(0 0 40px var(--cat-glow, var(--gold-glow)));
  animation: count-pulse 1s ease-in-out infinite;
}

/* ---- PLAYING ---- */

.phase-playing {
  animation: slide-up 0.3s ease-out;
}

.q-header {
  margin-bottom: 24px;
}

.progress-track {
  height: 4px;
  background: var(--bg-elevated);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 12px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--cat-color, var(--gold)), var(--cyan));
  border-radius: 2px;
  transition: width 0.4s ease;
}

.q-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.q-num {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
}

.diff-pill {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  color: #fff;
}

.diff-easy { background: var(--emerald); }
.diff-medium { background: var(--gold); color: #0c0a1a; }
.diff-hard { background: var(--rose); }

.pts-pill {
  font-size: 12px;
  font-weight: 600;
  color: var(--violet);
  background: var(--violet-glow);
  padding: 2px 10px;
  border-radius: var(--radius-full);
}

.score-pill {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
}

.q-text {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
  margin-bottom: 24px;
}

.options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.options-two {
  grid-template-columns: 1fr;
}

.opt-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
  min-height: 56px;
}

.opt-btn:hover {
  border-color: var(--cat-border, var(--border-strong));
  background: var(--cat-bg, var(--bg-elevated));
}

.opt-btn:active { transform: scale(0.97); }

.opt-letter {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary);
}

.opt-text {
  flex: 1;
}

.skip-btn {
  display: block;
  margin: 16px auto 0;
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-family: var(--font-display);
  font-size: 14px;
  cursor: pointer;
  padding: 8px 16px;
  transition: color 0.2s;
}

.skip-btn:hover { color: var(--text-secondary); }

/* ---- FEEDBACK ---- */

.phase-feedback {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 60px 0;
}

.feedback-loader {
  width: 36px;
  height: 36px;
  border: 3px solid var(--border-medium);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.feedback-text {
  color: var(--text-secondary);
  font-size: 15px;
}

/* ---- RECONNECTING ---- */

.phase-reconnecting {
  text-align: center;
  animation: scale-in 0.3s ease-out;
}

.reconnect-icon {
  font-size: 48px;
  margin-bottom: 8px;
}

.phase-reconnecting h1 {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 4px;
}

.reconnect-sub {
  color: var(--text-secondary);
  font-size: 15px;
  margin-bottom: 20px;
}

/* ---- TIMEOUT ---- */

.phase-timeout {
  text-align: center;
  animation: scale-in 0.3s ease-out;
}

.timeout-icon {
  font-size: 56px;
  margin-bottom: 8px;
}

.phase-timeout h1 {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 4px;
}

.timeout-sub {
  color: var(--text-secondary);
  margin-bottom: 24px;
}

.timeout-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

/* ---- WAITING DONE ---- */

.phase-waiting-done {
  text-align: center;
  animation: scale-in 0.4s ease-out;
}

.wd-icon {
  font-size: 56px;
  margin-bottom: 8px;
}

.phase-waiting-done h1 {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 16px;
}

.wd-score { margin-bottom: 16px; }

.wd-score-num {
  display: block;
  font-family: var(--font-mono);
  font-size: 56px;
  font-weight: 700;
  line-height: 1;
  color: var(--cat-color, var(--gold-light));
  filter: drop-shadow(0 0 20px var(--cat-glow, var(--gold-glow)));
}

.wd-score-label {
  font-size: 16px;
  color: var(--text-secondary);
  margin-top: 4px;
  display: block;
}

.wd-sub {
  color: var(--text-secondary);
  font-size: 15px;
  margin-bottom: 16px;
}

/* ---- GAME OVER ---- */

.phase-gameover {
  text-align: center;
  animation: scale-in 0.4s ease-out;
}

.go-trophy {
  font-size: 72px;
  margin-bottom: 8px;
  animation: float 3s ease-in-out infinite;
}

.phase-gameover h1 {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 24px;
}

.go-score {
  margin-bottom: 24px;
}

.go-score-num {
  display: block;
  font-family: var(--font-mono);
  font-size: 72px;
  font-weight: 700;
  line-height: 1;
  color: var(--cat-color, var(--gold-light));
  filter: drop-shadow(0 0 20px var(--cat-glow, var(--gold-glow)));
}

.go-score-label {
  font-size: 16px;
  color: var(--text-secondary);
  margin-top: 4px;
  display: block;
}

.go-stats {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
}

.go-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.go-stat-num {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

.go-stat-label {
  font-size: 13px;
  color: var(--text-muted);
}

.go-divider {
  width: 1px;
  height: 40px;
  background: var(--border-medium);
}

/* ---- Responsive ---- */

@media (max-width: 480px) {
  .options { grid-template-columns: 1fr; }
  .q-text { font-size: 19px; }
  .countdown-big { font-size: 88px; }
  .brand-title { font-size: 28px; }
}

/* ---- Report ---- */

.report-summary {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.report-pills {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

.rpill {
  font-size: 13px;
  font-weight: 600;
  padding: 4px 14px;
  border-radius: var(--radius-full);
}

.rpill-correct { background: rgba(16, 185, 129, 0.12); color: var(--emerald); }
.rpill-wrong { background: rgba(244, 63, 94, 0.1); color: var(--rose); }
.rpill-skip { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }

.btn-report {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  color: var(--text-secondary);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-report:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.report-arrow {
  font-size: 11px;
  transition: transform 0.2s;
}

.report-arrow.open { transform: rotate(180deg); }

.report {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  max-height: 400px;
  overflow-y: auto;
}

.report-item {
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
}

.ri-correct { border-left: 3px solid var(--emerald); }
.ri-wrong { border-left: 3px solid var(--rose); }
.ri-skip { border-left: 3px solid var(--text-muted); }

.ri-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.ri-num {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--text-muted);
}

.ri-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  color: #fff;
}

.ri-badge-easy { background: var(--emerald); }
.ri-badge-medium { background: var(--gold); color: #0c0a1a; }
.ri-badge-hard { background: var(--rose); }

.ri-pts {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
}

.ri-result {
  margin-left: auto;
  font-size: 16px;
  font-weight: 700;
}

.ri-correct .ri-result { color: var(--emerald); }
.ri-wrong .ri-result { color: var(--rose); }
.ri-skip .ri-result { color: var(--text-muted); }

.ri-question {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.4;
}

.ri-answer {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.ri-yours { color: var(--rose); }
.ri-correct-answer { color: var(--emerald); }
</style>