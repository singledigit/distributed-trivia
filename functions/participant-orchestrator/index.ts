/**
 * Participant Orchestrator (POD) — Durable Function
 *
 * Per-player game orchestration: join ack, wait for start, question delivery,
 * scoring, activity logging, timeout handling, and post-game report.
 *
 * Each question is processed in its own child context for clean isolation
 * of the waitForCallback/timeout/retry logic.
 */

import { withDurableExecution, DurableContext, CallbackError } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  sessionPK,
  PACKAGE_SK,
  METADATA_SK,
  playerSK,
  activitySK,
  ttl24h,
  calculateScore,
  publishToChannel,
} from './shared/index';
import type { Question, PlayerStatus, ActivityStatus } from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.GAME_TABLE_NAME!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CallbackPayload {
  action: 'start' | 'ready' | 'answer' | 'skip' | 'more_time' | 'complete';
  startTime?: string;
  selectedOption?: string;
}

interface QuestionResult {
  questionNum: number;
  questionText: string;
  options: string[];
  correctAnswer: string;
  difficulty: string;
  points: number;
  selectedOption: string | null;
  isCorrect: boolean;
  wasSkipped: boolean;
}

/** Outcome of processing a single question */
interface QuestionOutcome {
  score: number;
  result: QuestionResult;
  earlyExit: boolean; // true if game ended mid-question (timed mode)
}

interface ParticipantOrchestratorEvent {
  sessionId: string;
  participantId: string;
  displayName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a callback result — the SDK may return a JSON string */
function parseCallback<T>(raw: unknown): T {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return raw as T; }
  }
  return raw as T;
}

/** Write an activity record to DDB */
async function writeActivity(
  ctx: DurableContext,
  stepName: string,
  pk: string,
  participantId: string,
  questionId: string,
  questionNum: number,
  seq: number,
  status: ActivityStatus,
  answer: string | null,
  points: number,
) {
  await ctx.step(stepName, async () => {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk,
        SK: activitySK(participantId, questionNum, seq),
        participantId,
        questionId,
        answer,
        status,
        points,
        timestamp: new Date().toISOString(),
        ttl: ttl24h(),
      },
    }));
  });
}

/** Build a skip/auto-skip QuestionResult */
function skipResult(question: Question, questionNum: number): QuestionResult {
  return {
    questionNum,
    questionText: question.questionText,
    options: question.options,
    correctAnswer: question.correctAnswer,
    difficulty: question.difficulty,
    points: 0,
    selectedOption: null,
    isCorrect: false,
    wasSkipped: true,
  };
}

// ---------------------------------------------------------------------------
// Process a single question in a child context
// ---------------------------------------------------------------------------

async function processQuestion(
  context: DurableContext,
  question: Question,
  qIndex: number,
  totalQuestions: number,
  currentScore: number,
  pk: string,
  participantId: string,
  playerChannel: string,
): Promise<QuestionOutcome> {
  const questionNum = qIndex + 1;

  return context.runInChildContext<QuestionOutcome>(
    `question-${questionNum}`,
    async (qCtx) => {
      let seq = 1;
      qCtx.logger.info(`Entered child context for Q${questionNum}`);

      /** Publish the question to the player with a callback token */
      const sendQuestion = async (callbackToken: string) => {
        await publishToChannel({
          channel: playerChannel,
          events: [{
            type: 'question',
            questionNum,
            totalQuestions,
            questionId: question.questionId,
            questionText: question.questionText,
            options: question.options,
            difficulty: question.difficulty,
            points: question.points,
            callbackToken,
            currentScore,
          }],
        });
      };

      // Question loop — handles answer, skip, more_time, timeout, and game-end
      while (true) {
        try {
          qCtx.logger.info(`Q${questionNum} seq${seq}: entering waitForCallback`);
          const responseRaw = await qCtx.waitForCallback<CallbackPayload>(
            `wait-seq${seq}`,
            async (callbackToken) => {
              qCtx.logger.info(`Q${questionNum} seq${seq}: setup fn called, sending question`);
              await sendQuestion(callbackToken);
              qCtx.logger.info(`Q${questionNum} seq${seq}: question sent`);
            },
            { timeout: { seconds: 15 } },
          );
          const response = parseCallback<CallbackPayload>(responseRaw);
          qCtx.logger.info(`Q${questionNum} seq${seq}: callback received`, { action: response.action });

          // Game ended externally (timed mode — "TIMES UP")
          if (response.action === 'complete') {
            return { score: 0, result: skipResult(question, questionNum), earlyExit: true };
          }

          // Player wants more time
          if (response.action === 'more_time') {
            await writeActivity(qCtx, `activity-seq${seq}-extended`, pk, participantId, question.questionId, questionNum, seq, 'extended', null, 0);
            seq++;
            continue;
          }

          // Player answered or skipped
          if (response.action === 'answer' || response.action === 'skip') {
            // Validate the selected option is actually one of the choices
            if (response.action === 'answer' && response.selectedOption && !question.options.includes(response.selectedOption)) {
              qCtx.logger.warn('Invalid answer option submitted', { selectedOption: response.selectedOption });
              seq++;
              continue; // Re-send the question with a new callback token
            }

            const isCorrect = response.action === 'answer' && response.selectedOption === question.correctAnswer;
            const points = response.action === 'skip' ? 0 : calculateScore(question.difficulty, isCorrect);
            const activityStatus: ActivityStatus = response.action === 'skip' ? 'skipped' : isCorrect ? 'correct' : 'incorrect';

            await writeActivity(qCtx, `activity-seq${seq}`, pk, participantId, question.questionId, questionNum, seq, activityStatus, response.selectedOption ?? null, points);

            return {
              score: points,
              result: {
                questionNum,
                questionText: question.questionText,
                options: question.options,
                correctAnswer: question.correctAnswer,
                difficulty: question.difficulty,
                points,
                selectedOption: response.selectedOption ?? null,
                isCorrect,
                wasSkipped: response.action === 'skip',
              },
              earlyExit: false,
            };
          }
        } catch (error) {
          if (!(error instanceof CallbackError)) throw error;

          // Timeout — write activity, send timeout prompt
          qCtx.logger.info(`Q${questionNum} seq${seq}: TIMEOUT FIRED — CallbackError caught`);
          await writeActivity(qCtx, `activity-seq${seq}-timeout`, pk, participantId, question.questionId, questionNum, seq, 'extended', null, 0);
          seq++;

          try {
            const timeoutRaw = await qCtx.waitForCallback<CallbackPayload>(
              `timeout-seq${seq}`,
              async (callbackToken) => {
                await publishToChannel({
                  channel: playerChannel,
                  events: [{ type: 'timeout_prompt', questionNum, questionId: question.questionId, callbackToken }],
                });
              },
              { timeout: { seconds: 15 } },
            );
            const timeoutResponse = parseCallback<CallbackPayload>(timeoutRaw);

            if (timeoutResponse.action === 'more_time') { seq++; continue; }
            if (timeoutResponse.action === 'complete') {
              return { score: 0, result: skipResult(question, questionNum), earlyExit: true };
            }
            if (timeoutResponse.action === 'skip') {
              await writeActivity(qCtx, `activity-seq${seq}-skip`, pk, participantId, question.questionId, questionNum, seq, 'skipped', null, 0);
              return { score: 0, result: skipResult(question, questionNum), earlyExit: false };
            }
          } catch (innerError) {
            if (!(innerError instanceof CallbackError)) throw innerError;

            // Double timeout — auto-skip
            qCtx.logger.info(`Double timeout, auto-skipping`);
            await writeActivity(qCtx, `activity-seq${seq}-autoskip`, pk, participantId, question.questionId, questionNum, seq, 'skipped', null, 0);
            return { score: 0, result: skipResult(question, questionNum), earlyExit: false };
          }
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handler = withDurableExecution(
  async (event: ParticipantOrchestratorEvent, context: DurableContext): Promise<unknown> => {
    const { sessionId, participantId, displayName } = event;
    const playerChannel = `player/${sessionId}/${participantId}`;
    const pk = sessionPK(sessionId);

    context.logger.info('POD started', { sessionId, participantId, displayName });

    // Step 1: Read question package
    const questions: Question[] = await context.step('read-package', async () => {
      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: PACKAGE_SK },
      }));
      if (!result.Item) throw new Error(`PACKAGE not found for session ${sessionId}`);
      return result.Item.questions as Question[];
    });

    // Step 1b: Read session metadata for category name and emoji
    const categoryMeta = await context.step('read-category-meta', async () => {
      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: METADATA_SK },
        ProjectionExpression: 'categoryName, categoryEmoji, categoryColor, #m',
        ExpressionAttributeNames: { '#m': 'mode' },
      }));
      return {
        categoryName: (result.Item?.categoryName as string) ?? '',
        categoryEmoji: (result.Item?.categoryEmoji as string) ?? '',
        categoryColor: (result.Item?.categoryColor as string) ?? '',
        mode: (result.Item?.mode as string) ?? '',
      };
    });

    // Step 2: Write PLAYER# record
    await context.step('write-player-record', async () => {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: pk,
          SK: playerSK(participantId),
          participantId,
          displayName,
          status: 'waiting' as PlayerStatus,
          joinedAt: new Date().toISOString(),
          ttl: ttl24h(),
        },
      }));
    });

    // Step 3: Wait for game start — register callback token BEFORE publishing join_ack
    // This ensures the podCallbackToken is in DDB before the host can click Start
    let startPayloadRaw: string;
    try {
    startPayloadRaw = await context.waitForCallback<string>(
      'wait-for-start',
      async (callbackToken) => {
        // Write callback token to PLAYER# record so ODF can find it
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: pk, SK: playerSK(participantId) },
          UpdateExpression: 'SET podCallbackToken = :token',
          ExpressionAttributeValues: { ':token': callbackToken },
        }));

        // NOW publish join_ack — token is safely in DDB
        await publishToChannel({
          channel: playerChannel,
          events: [{ type: 'join_ack', sessionId, participantId, displayName, questionCount: questions.length, mode: categoryMeta.mode, categoryName: categoryMeta.categoryName, categoryEmoji: categoryMeta.categoryEmoji, categoryColor: categoryMeta.categoryColor }],
        });
      },
      { timeout: { minutes: 35 } }, // Must exceed ODF's 30-min lobby timeout
    );
    } catch (error) {
      if (error instanceof CallbackError) {
        // Lobby timed out — game was never started. Clean up and exit.
        context.logger.info('Wait-for-start timed out — session likely cancelled');
        await context.step('write-abandoned-status', async () => {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { PK: pk, SK: playerSK(participantId) },
            UpdateExpression: 'SET #s = :status',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus },
          }));
        });
        return { status: 'abandoned', participantId };
      }
      throw error;
    }

    const startPayload = parseCallback<CallbackPayload>(startPayloadRaw);
    context.logger.info('Start payload received', { startTime: startPayload.startTime });

    // Step 5: Wait for "ready" — publish start time + callback token
    try {
      await context.waitForCallback<CallbackPayload>(
        'wait-for-ready',
        async (callbackToken) => {
          await publishToChannel({
            channel: playerChannel,
            events: [{ type: 'game_starting', startTime: startPayload.startTime, callbackToken }],
          });
        },
        { timeout: { seconds: 30 } },
      );
    } catch (error) {
      if (error instanceof CallbackError) {
        context.logger.warn('Player did not send ready in time, proceeding anyway');
      } else {
        throw error;
      }
    }

    // Step 6: Update status to playing
    await context.step('update-status-playing', async () => {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: playerSK(participantId) },
        UpdateExpression: 'SET #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'playing' as PlayerStatus },
      }));
    });

    // Step 7: Question loop — each question in its own child context
    let totalScore = 0;
    const questionResults: QuestionResult[] = [];

    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
      const outcome = await processQuestion(
        context, questions[qIndex], qIndex, questions.length,
        totalScore, pk, participantId, playerChannel,
      );

      totalScore += outcome.score;
      questionResults.push(outcome.result);

      if (outcome.earlyExit) {
        // Game ended mid-question (timed mode) — finalize
        await context.step('write-final-status-early', async () => {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { PK: pk, SK: playerSK(participantId) },
            UpdateExpression: 'SET #s = :status',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus },
          }));
        });

        await context.step('publish-completion-early', async () => {
          await publishToChannel({
            channel: playerChannel,
            events: [{ type: 'game_complete', totalScore, questionsAnswered: qIndex, totalQuestions: questions.length, questionResults }],
          });
        });

        return { status: 'completed', totalScore, questionsAnswered: qIndex };
      }
    }

    // All questions answered — publish interim status and wait for game end
    await context.step('publish-all-answered', async () => {
      await publishToChannel({
        channel: playerChannel,
        events: [{
          type: 'all_questions_answered',
          totalScore,
          questionsAnswered: questions.length,
          totalQuestions: questions.length,
          questionResults,
        }],
      });
    });

    // Wait for game-end signal (times_up or cancel from game channel → client sends complete)
    try {
      await context.waitForCallback<CallbackPayload>(
        'wait-for-game-end',
        async (callbackToken) => {
          // Publish the callback token so the client can send 'complete' when the game ends
          await publishToChannel({
            channel: playerChannel,
            events: [{ type: 'waiting_for_game_end', callbackToken }],
          });
        },
        { timeout: { seconds: 600 } }, // 10 min max — game should end well before this
      );
    } catch (error) {
      if (error instanceof CallbackError) {
        context.logger.info('Game end wait timed out, finalizing anyway');
      } else {
        throw error;
      }
    }

    // Finalize
    await context.step('write-final-status', async () => {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: playerSK(participantId) },
        UpdateExpression: 'SET #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus },
      }));
    });

    await context.step('publish-completion', async () => {
      await publishToChannel({
        channel: playerChannel,
        events: [{ type: 'game_complete', totalScore, questionsAnswered: questions.length, totalQuestions: questions.length, questionResults }],
      });
    });

    context.logger.info('POD completed', { sessionId, participantId, totalScore });
    return { status: 'completed', totalScore, questionsAnswered: questions.length };
  },
);
