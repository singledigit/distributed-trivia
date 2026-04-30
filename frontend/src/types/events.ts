/**
 * Discriminated union types for AppSync Events channel payloads.
 * Each channel has its own set of event types, discriminated by `type`.
 */

// ---------------------------------------------------------------------------
// Admin channel — /admin/{sessionId}
// ---------------------------------------------------------------------------

export type AdminEvent =
  | { type: 'snapshot'; sessionId: string; status: string; players: AdminSnapshotPlayer[] }
  | { type: 'session_created'; sessionId: string }
  | { type: 'error'; message: string }

export interface AdminSnapshotPlayer {
  participantId: string
  displayName: string
  status: string
  score: number
  currentQuestion: number
  statusDot: string
}

// ---------------------------------------------------------------------------
// Admin default channel — /admin/default
// ---------------------------------------------------------------------------

export type AdminDefaultEvent =
  | { type: 'categories'; categories: CategoryItem[] }
  | { type: 'ack'; sessionId: string }
  | { type: 'session_created' }

export interface CategoryItem {
  categoryId: string
  categoryName: string
}

// ---------------------------------------------------------------------------
// Leaderboard channel — /leaderboard/{sessionId}
// ---------------------------------------------------------------------------

export type LeaderboardEvent =
  | { type: 'snapshot'; sessionId: string; status: string; players: LeaderboardPlayer[]; questionCount?: number; mode?: string; timeLimitMinutes?: number; startTime?: string; categoryName?: string; categoryEmoji?: string; categoryColor?: string }
  | { type: 'player_list'; players: LeaderboardPlayerListItem[] }
  | { type: 'player_update'; participantId: string; totalScore: number; currentQuestion: number; statusDot: string; latestStatus: string }
  | { type: 'player_completed'; participantId: string }

export interface LeaderboardPlayer {
  participantId: string
  displayName: string
  status: string
  score: number
  currentQuestion: number
  statusDot: string
}

export interface LeaderboardPlayerListItem {
  participantId: string
  displayName: string
  status: string
  joinedAt: string
}

// ---------------------------------------------------------------------------
// Game channel — /game/{sessionId}
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'game_started'; sessionId: string; startTime: string; mode: string; timeLimitMinutes: number }
  | { type: 'times_up'; sessionId: string }
  | { type: 'game_cancelled'; sessionId: string; reason?: string }

// ---------------------------------------------------------------------------
// Player channel — /player/{sessionId}/{participantId}
// ---------------------------------------------------------------------------

export type PlayerEvent =
  | { type: 'join_ack'; sessionId: string; participantId: string; displayName: string; questionCount: number; mode: string; categoryName: string; categoryEmoji: string; categoryColor: string }
  | { type: 'game_starting'; startTime: string; callbackToken: string }
  | { type: 'waiting_for_ready'; callbackToken: string }
  | { type: 'question'; questionNum: number; totalQuestions: number; questionId: string; questionText: string; options: string[]; difficulty: string; points: number; callbackToken: string; currentScore: number }
  | { type: 'timeout_prompt'; questionNum: number; questionId: string; callbackToken: string }
  | { type: 'game_complete'; totalScore: number; questionsAnswered: number; totalQuestions: number; questionResults: QuestionResultPayload[] }
  | { type: 'all_questions_answered'; totalScore: number; questionsAnswered: number; totalQuestions: number; questionResults: QuestionResultPayload[] }
  | { type: 'waiting_for_game_end'; callbackToken: string }
  | { type: 'error'; message: string }

export interface QuestionResultPayload {
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

// ---------------------------------------------------------------------------
// Join channel — /player/{sessionId}/join
// ---------------------------------------------------------------------------

export type JoinEvent =
  | { type: 'joined'; sessionId: string; participantId: string; displayName: string }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Categories channel — /categories/default
// ---------------------------------------------------------------------------

export type CategoriesEvent =
  | { type: 'categories'; categories: CategoryItem[] }
  | { type: 'ack'; action: string; categoryId?: string }
  | { type: 'category_progress'; categoryId: string; step: string; message: string }
  | { type: 'category_created'; categoryId: string; categoryName: string; questionCount: number }
  | { type: 'error'; message: string }
