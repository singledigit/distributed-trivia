/**
 * Validation helpers for trivia game inputs.
 */

import type { GameMode } from './types';

// --- Display name ---

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 20;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a player display name.
 * Must be 1-20 characters after trimming whitespace.
 */
export function validateDisplayName(name: unknown): ValidationResult {
  if (typeof name !== 'string') {
    return { valid: false, error: 'Display name must be a string' };
  }
  const trimmed = name.trim();
  if (trimmed.length < DISPLAY_NAME_MIN) {
    return { valid: false, error: 'Display name cannot be empty' };
  }
  if (trimmed.length > DISPLAY_NAME_MAX) {
    return { valid: false, error: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer` };
  }
  return { valid: true };
}

// --- Game mode ---

const VALID_MODES: GameMode[] = ['timed', 'question_count'];

/**
 * Validate the game mode value.
 */
export function validateMode(mode: unknown): ValidationResult {
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as GameMode)) {
    return { valid: false, error: `Mode must be one of: ${VALID_MODES.join(', ')}` };
  }
  return { valid: true };
}

// --- Question count ---

const QUESTION_COUNT_MIN = 1;
const QUESTION_COUNT_MAX = 30;

/**
 * Validate question count (1-30).
 */
export function validateQuestionCount(count: unknown): ValidationResult {
  if (typeof count !== 'number' || !Number.isInteger(count)) {
    return { valid: false, error: 'Question count must be an integer' };
  }
  if (count < QUESTION_COUNT_MIN || count > QUESTION_COUNT_MAX) {
    return {
      valid: false,
      error: `Question count must be between ${QUESTION_COUNT_MIN} and ${QUESTION_COUNT_MAX}`,
    };
  }
  return { valid: true };
}

// --- Time limit ---

const TIME_LIMIT_MIN = 1;
const TIME_LIMIT_MAX = 5;

/**
 * Validate time limit in minutes (1-5).
 */
export function validateTimeLimit(minutes: unknown): ValidationResult {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
    return { valid: false, error: 'Time limit must be an integer' };
  }
  if (minutes < TIME_LIMIT_MIN || minutes > TIME_LIMIT_MAX) {
    return {
      valid: false,
      error: `Time limit must be between ${TIME_LIMIT_MIN} and ${TIME_LIMIT_MAX} minutes`,
    };
  }
  return { valid: true };
}
