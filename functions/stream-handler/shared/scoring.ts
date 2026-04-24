/**
 * Scoring logic for trivia answers.
 *
 * Points by difficulty (correct answers only):
 *   easy   = 10
 *   medium = 20
 *   hard   = 30
 *
 * Incorrect answers and skips always score 0.
 */

import type { Difficulty } from './types';

const POINTS_BY_DIFFICULTY: Record<Difficulty, number> = {
  easy: 10,
  medium: 20,
  hard: 30,
};

/**
 * Calculate points for an answer.
 *
 * @param difficulty - The question difficulty level
 * @param isCorrect - Whether the player answered correctly
 * @returns Points awarded (0 for incorrect/skip)
 */
export function calculateScore(difficulty: Difficulty, isCorrect: boolean): number {
  return isCorrect ? POINTS_BY_DIFFICULTY[difficulty] : 0;
}

/**
 * Get the point value for a difficulty level (used when building question packages).
 */
export function pointsForDifficulty(difficulty: Difficulty): number {
  return POINTS_BY_DIFFICULTY[difficulty];
}
