/**
 * Shared type definitions for the trivia game.
 */

// --- Game modes ---

export type GameMode = 'timed' | 'question_count';

// --- Difficulty levels ---

export type Difficulty = 'easy' | 'medium' | 'hard';

// --- Session status ---

export type SessionStatus = 'waiting' | 'in_progress' | 'completed' | 'cancelled';

// --- Player status ---

export type PlayerStatus = 'waiting' | 'playing' | 'completed';

// --- Activity status ---

export type ActivityStatus = 'correct' | 'incorrect' | 'skipped' | 'extended';

// --- Question ---

export interface Question {
  questionId: string;
  questionText: string;
  options: string[];
  correctAnswer: string;
  difficulty: Difficulty;
  points: number;
}

// --- DynamoDB record shapes ---

export interface SessionMetadata {
  PK: string;
  SK: 'METADATA';
  sessionId: string;
  categoryId: string;
  categoryName?: string;
  categoryEmoji?: string;
  categoryColor?: string;
  mode: GameMode;
  questionCount: number;
  timeLimitMinutes: number;
  status: SessionStatus;
  odfCallbackToken?: string;
  createdAt: string;
  ttl: number;
}

export interface SessionPackage {
  PK: string;
  SK: 'PACKAGE';
  questions: Question[];
  ttl: number;
}

export interface PlayerRecord {
  PK: string;
  SK: string; // PLAYER#{participantId}
  participantId: string;
  displayName: string;
  podCallbackToken?: string;
  status: PlayerStatus;
  joinedAt: string;
  ttl: number;
}

export interface ActivityRecord {
  PK: string;
  SK: string; // ACTIVITY#{participantId}#{questionNum}#{seq}
  participantId: string;
  questionId: string;
  answer: string | null;
  status: ActivityStatus;
  points: number;
  timestamp: string;
  ttl: number;
}

// --- Category ---

export interface CategoryMetadata {
  PK: string;
  SK: 'METADATA';
  categoryId: string;
  categoryName?: string;
  categoryEmoji?: string;
  categoryColor?: string;
  categoryName: string;
}

// --- AppSync Events ---

export interface AppSyncEventsLambdaEvent {
  type: 'EVENT_PUBLISH' | 'EVENT_SUBSCRIBE';
  events?: Array<{
    id: string;
    payload: Record<string, unknown> | string;
  }>;
  info?: {
    channel: {
      path: string;
      segments: string[];
    };
    channelNamespace?: {
      name: string;
    };
    operation?: string;
  };
}
