import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { subscribe, publish } from '../appsync-events'
import { useCountdown } from './useCountdown'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GamePhase =
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

export interface QuestionResult {
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

export interface CurrentQuestion {
  questionNum: number
  totalQuestions: number
  questionText: string
  options: string[]
  difficulty: string
  points: number
  callbackToken: string
  currentScore: number
}

interface StoredState {
  participantId: string
  displayName: string
  phase: GamePhase
  questionCount: number
  categoryName: string
  categoryEmoji: string
  categoryColor: string
  currentQuestion: CurrentQuestion | null
  lastCallbackToken: string
  finalScore: number
  questionsAnswered: number
  totalQuestions: number
  questionResults: QuestionResult[]
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function usePlayerSession(sessionId: string) {
  // State
  const phase = ref<GamePhase>('join')
  const displayName = ref('')
  const nameError = ref('')
  const participantId = ref('')
  const questionCount = ref(0)
  const categoryName = ref('')
  const categoryEmoji = ref('')
  const categoryColor = ref('')
  const gameMode = ref('')
  const currentQuestion = ref<CurrentQuestion | null>(null)
  const lastAnswerCorrect = ref<boolean | null>(null)
  const timeoutCallbackToken = ref('')
  const lastCallbackToken = ref('')
  const finalScore = ref(0)
  const questionsAnswered = ref(0)
  const totalQuestions = ref(0)
  const questionResults = ref<QuestionResult[]>([])
  const readyCallbackToken = ref('')
  const waitingEndCallbackToken = ref('')

  const { seconds: countdownSeconds, start: startCountdownTimer, stop: stopCountdown } = useCountdown()
  const unsubscribers: (() => void)[] = []
  let joinStartTime = 0
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null

  // Computed
  const isNameValid = computed(() => {
    const trimmed = displayName.value.trim()
    return trimmed.length >= 1 && trimmed.length <= 20
  })

  const difficultyLabel = computed(() => currentQuestion.value?.difficulty ?? '')
  const difficultyClass = computed(() => `diff-${currentQuestion.value?.difficulty ?? 'easy'}`)

  const progressPercent = computed(() => {
    if (!currentQuestion.value) return 0
    return Math.round(((currentQuestion.value.questionNum - 1) / currentQuestion.value.totalQuestions) * 100)
  })

  const categoryTheme = computed(() => {
    return { emoji: categoryEmoji.value || '🧠', label: categoryName.value || 'Trivia' }
  })

  // -----------------------------------------------------------------------
  // Session storage
  // -----------------------------------------------------------------------

  const STORAGE_KEY = `trivia_player_${sessionId}`

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

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  function validateName() {
    const trimmed = displayName.value.trim()
    if (trimmed.length === 0) { nameError.value = 'Name is required'; return false }
    if (trimmed.length > 20) { nameError.value = 'Name must be 20 characters or less'; return false }
    nameError.value = ''
    return true
  }

  // -----------------------------------------------------------------------
  // Channel helpers
  // -----------------------------------------------------------------------

  function playerChannel() { return `/player/${sessionId}/${participantId.value}` }
  function gameChannel() { return `/game/${sessionId}` }
  function joinChannel() { return `/player/${sessionId}/join` }

  // -----------------------------------------------------------------------
  // Feedback timeout
  // -----------------------------------------------------------------------

  function startFeedbackTimeout() {
    clearFeedbackTimeout()
    feedbackTimer = setTimeout(() => {
      if (phase.value === 'feedback') {
        console.warn('[player] Feedback timeout — waiting for POD to send next event')
        phase.value = 'reconnecting'
      }
    }, 8000)
  }

  function clearFeedbackTimeout() {
    if (feedbackTimer) { clearTimeout(feedbackTimer); feedbackTimer = null }
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

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
    startCountdownTimer(startTimeStr, () => sendReady())
    saveState()
  }

  async function sendReady() {
    if (!readyCallbackToken.value) return
    try {
      await publish(playerChannel(), [{ action: 'ready', callbackToken: readyCallbackToken.value }])
      readyCallbackToken.value = ''
    } catch (err) { console.error('[player] Failed to send ready:', err) }
  }

  async function handleJoin() {
    if (!validateName()) return
    phase.value = 'joining'
    nameError.value = ''
    joinStartTime = Date.now()

    const myName = displayName.value.trim()
    let joined = false
    let joinUnsub: (() => void) | null = null

    try {
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
          joined = true
          nameError.value = data.message as string
          phase.value = 'join'
        }
      })
      unsubscribers.push(() => { if (joinUnsub) joinUnsub() })

      for (let attempt = 1; attempt <= 3 && !joined; attempt++) {
        await publish(joinChannel(), [{ action: 'join', displayName: myName }])

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
    const token = waitingEndCallbackToken.value || lastCallbackToken.value
    if (token && phase.value !== 'game_over') {
      try {
        await publish(playerChannel(), [{ action: 'complete', callbackToken: token }])
      } catch (err) { console.error('[player] Failed to send complete:', err) }
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

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
        currentQuestion.value = stored.currentQuestion
        phase.value = 'playing'
      } else if (stored.phase === 'feedback' && stored.currentQuestion) {
        currentQuestion.value = stored.currentQuestion
        phase.value = 'playing'
      } else {
        phase.value = stored.phase
        if (stored.currentQuestion) currentQuestion.value = stored.currentQuestion
      }
      await subscribeToChannels()
    }
  })

  onUnmounted(() => {
    clearFeedbackTimeout()
    for (const unsub of unsubscribers) unsub()
  })

  watch(phase, () => { if (participantId.value) saveState() })

  return {
    // State
    phase,
    displayName,
    nameError,
    participantId,
    questionCount,
    categoryName,
    categoryEmoji,
    categoryColor,
    gameMode,
    currentQuestion,
    countdownSeconds,
    finalScore,
    questionsAnswered,
    totalQuestions,
    questionResults,
    // Computed
    isNameValid,
    difficultyLabel,
    difficultyClass,
    progressPercent,
    categoryTheme,
    // Actions
    handleJoin,
    submitAnswer,
    skipQuestion,
    requestMoreTime,
    skipFromTimeout,
  }
}
