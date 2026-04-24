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

// Subscriptions
const unsubscribers: (() => void)[] = []

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

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
  questionResults: QuestionResult[]
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
      questionResults.value = (data.questionResults as QuestionResult[]) ?? []
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

async function submitAnswer(option: string) {
  if (!currentQuestion.value) return
  const token = currentQuestion.value.callbackToken
  phase.value = 'feedback'
  try {
    await publish(playerChannel(), [{ action: 'answer', selectedOption: option, callbackToken: token }])
  } catch (err) { console.error('[player] Failed to submit answer:', err); phase.value = 'playing' }
}

async function skipQuestion() {
  if (!currentQuestion.value) return
  const token = currentQuestion.value.callbackToken
  phase.value = 'feedback'
  try {
    await publish(playerChannel(), [{ action: 'skip', callbackToken: token }])
  } catch (err) { console.error('[player] Failed to skip:', err); phase.value = 'playing' }
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
  if (lastCallbackToken.value && phase.value !== 'game_over') {
    try {
      await publish(playerChannel(), [{ action: 'complete', callbackToken: lastCallbackToken.value }])
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

const optionColors = ['cyan', 'gold', 'emerald', 'rose']

// Report computed
const correctCount = computed(() => questionResults.value.filter(r => r.isCorrect).length)
const incorrectCount = computed(() => questionResults.value.filter(r => !r.isCorrect && !r.wasSkipped).length)
const skippedCount = computed(() => questionResults.value.filter(r => r.wasSkipped).length)

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  const stored = loadState()
  if (stored && stored.participantId) {
    participantId.value = stored.participantId
    displayName.value = stored.displayName
    questionCount.value = stored.questionCount
    lastCallbackToken.value = stored.lastCallbackToken
    finalScore.value = stored.finalScore
    questionsAnswered.value = stored.questionsAnswered
    totalQuestions.value = stored.totalQuestions
    questionResults.value = stored.questionResults ?? []

    if (stored.phase === 'game_over') {
      phase.value = 'game_over'
    } else if (stored.phase === 'join' || stored.phase === 'joining') {
      phase.value = 'join'
      return
    } else {
      phase.value = stored.phase === 'playing' || stored.phase === 'feedback' ? 'playing' : stored.phase
      if (stored.currentQuestion) currentQuestion.value = stored.currentQuestion
    }
    await subscribeToChannels()
  }
})

onUnmounted(() => {
  stopCountdown()
  for (const unsub of unsubscribers) unsub()
})

watch(phase, () => { if (participantId.value) saveState() })
</script>

<template>
  <div class="player">
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
        <div v-if="questionCount" class="info-pill">{{ questionCount }} questions</div>
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
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
          </div>
          <div class="q-meta">
            <span class="q-num">{{ currentQuestion.questionNum }}/{{ currentQuestion.totalQuestions }}</span>
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
            :class="['opt-btn', `opt-${optionColors[idx % 4]}`]"
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
  background: var(--gold);
  opacity: 0.05;
  top: -120px;
  left: -80px;
}

.bg-orb-2 {
  width: 300px;
  height: 300px;
  background: var(--cyan);
  opacity: 0.04;
  bottom: -100px;
  right: -60px;
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
  background: linear-gradient(135deg, var(--gold), #d97706);
  color: #0c0a1a;
  box-shadow: 0 2px 12px var(--gold-glow);
}

.btn-gold:hover:not(:disabled) {
  box-shadow: var(--shadow-glow-gold);
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
  border-color: var(--gold);
  box-shadow: 0 0 0 4px var(--gold-glow);
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
  background: var(--emerald-glow);
  border: 2px solid var(--emerald);
  color: var(--emerald);
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
  color: var(--gold-light);
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

.waiting-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
}

.waiting-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gold);
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
  background: linear-gradient(135deg, var(--gold-light), var(--gold));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 40px var(--gold-glow));
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
  background: linear-gradient(90deg, var(--gold), var(--cyan));
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
  border-color: var(--border-strong);
  background: var(--bg-elevated);
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

.opt-cyan .opt-letter { background: var(--cyan-subtle); color: var(--cyan-light); }
.opt-gold .opt-letter { background: var(--gold-subtle); color: var(--gold-light); }
.opt-emerald .opt-letter { background: rgba(16, 185, 129, 0.12); color: var(--emerald); }
.opt-rose .opt-letter { background: rgba(244, 63, 94, 0.1); color: var(--rose); }

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
  background: linear-gradient(135deg, var(--gold-light), var(--gold));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 20px var(--gold-glow));
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