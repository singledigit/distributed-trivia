/**
 * DynamoDB key builders for GameTable and QuestionsTable.
 *
 * Conventions:
 *   PK = SESSION#{sessionId}  or  CATEGORY#{categoryId}
 *   SK = METADATA | PACKAGE | PLAYER#{id} | ACTIVITY#{id}#{qNum}#{seq} | QUESTION#{id}
 */

// --- Partition keys ---

export function sessionPK(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function categoryPK(categoryId: string): string {
  return `CATEGORY#${categoryId}`;
}

// --- Sort keys ---

export const METADATA_SK = 'METADATA' as const;
export const PACKAGE_SK = 'PACKAGE' as const;

export function playerSK(participantId: string): string {
  return `PLAYER#${participantId}`;
}

export function activitySK(
  participantId: string,
  questionNum: number,
  seq: number,
): string {
  const qNum = String(questionNum).padStart(3, '0');
  const seqStr = String(seq).padStart(3, '0');
  return `ACTIVITY#${participantId}#${qNum}#${seqStr}`;
}

export function questionSK(questionId: string): string {
  return `QUESTION#${questionId}`;
}

// --- SK prefix constants for queries ---

export const PLAYER_PREFIX = 'PLAYER#' as const;
export const ACTIVITY_PREFIX = 'ACTIVITY#' as const;
export const QUESTION_PREFIX = 'QUESTION#' as const;

// --- TTL helper (24 hours from now) ---

export function ttl24h(): number {
  return Math.floor(Date.now() / 1000) + 86400;
}
