/**
 * Participant Orchestrator (POD) — Durable Function
 *
 * Per-player game orchestration: join ack, wait for start, question delivery,
 * scoring, and post-game report.
 *
 * Each question is processed in its own child context for clean isolation
 * of the waitForCallback/timeout/retry logic.
 *
 * The POD publishes leaderboard updates directly — no stream handler dependency
 * for score updates. The POD also includes its start callback token in join_ack
 * so the client can wake it directly when the game starts.
 */

import { withDurableExecution, DurableContext, CallbackError } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  sessionPK,
  PACKAGE_SK,
  METADATA_SK,
  playerSK,
  ttl24h,
  calculateScore,
  publishToChannel,
  statusDotColor,
} from './shared/index';
import type { Question, PlayerStatus, ActivityStatus } from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.GAME_TABLE_NAME!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CallbackPayload {
  action: 'start' | 'answer' | 'skip' | 'more_time' | 'complete';
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

/** Check if an error is a callback timeout */
function isCallbackTimeout(error: unknown): boolean {
  if (error instanceof CallbackError) return true;
  const msg = (error as { message?: string })?.message ?? '';
  const name = (error as { name?: string })?.name ?? '';
  return msg.includes('timed out') || msg.includes('Callback') || msg.includes('timeout')
    || name.includes('CallbackError') || name.includes('ChildContextError');
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
  sessionId: string,
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
              await sendQuestion(callbackToken);
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
            seq++;
            continue;
          }

          // Player answered or skipped
          if (response.action === 'answer' || response.action === 'skip') {
            if (response.action === 'answer' && response.selectedOption && !question.options.includes(response.selectedOption)) {
              qCtx.logger.warn('Invalid answer option submitted', { selectedOption: response.selectedOption });
              seq++;
              continue;
            }

            const isCorrect = response.action === 'answer' && response.selectedOption === question.correctAnswer;
            const points = response.action === 'skip' ? 0 : calculateScore(question.difficulty, isCorrect);
            const activityStatus: ActivityStatus = response.action === 'skip' ? 'skipped' : isCorrect ? 'correct' : 'incorrect';
            const newScore = currentScore + points;

            // Update PLAYER# record with score and publish leaderboard update
            await qCtx.step(`update-score-q${questionNum}`, async () => {
              await ddb.send(new UpdateCommand({
                TableName: TABLE,
                Key: { PK: pk, SK: playerSK(participantId) },
                UpdateExpression: 'SET score = :score, currentQuestion = :cq, statusDot = :dot',
                ExpressionAttributeValues: {
                  ':score': newScore,
                  ':cq': questionNum,
                  ':dot': statusDotColor(activityStatus),
                },
              }));
              await publishToChannel({
                channel: `leaderboard/${sessionId}`,
                events: [{
                  type: 'player_update',
                  participantId,
                  totalScore: newScore,
                  currentQuestion: questionNum,
                  statusDot: statusDotColor(activityStatus),
                  latestStatus: activityStatus,
                }],
              });
            });

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
          if (!isCallbackTimeout(error)) throw error;

          // Timeout — send timeout prompt
          qCtx.logger.info(`Q${questionNum} seq${seq}: TIMEOUT FIRED`);
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
            if (timeoutResponse.action === 'answer' || timeoutResponse.action === 'skip') {
              const isCorrect = timeoutResponse.action === 'answer' && timeoutResponse.selectedOption === question.correctAnswer;
              const points = timeoutResponse.action === 'skip' ? 0 : calculateScore(question.difficulty, isCorrect);
              const activityStatus: ActivityStatus = timeoutResponse.action === 'skip' ? 'skipped' : isCorrect ? 'correct' : 'incorrect';
              const newScore = currentScore + points;

              await qCtx.step(`update-score-q${questionNum}-timeout`, async () => {
                await ddb.send(new UpdateCommand({
                  TableName: TABLE,
                  Key: { PK: pk, SK: playerSK(participantId) },
                  UpdateExpression: 'SET score = :score, currentQuestion = :cq, statusDot = :dot',
                  ExpressionAttributeValues: {
                    ':score': newScore,
                    ':cq': questionNum,
                    ':dot': statusDotColor(activityStatus),
                  },
                }));
                await publishToChannel({
                  channel: `leaderboard/${sessionId}`,
                  events: [{
                    type: 'player_update',
                    participantId,
                    totalScore: newScore,
                    currentQuestion: questionNum,
                    statusDot: statusDotColor(activityStatus),
                    latestStatus: activityStatus,
                  }],
                });
              });

              return {
                score: points,
                result: { questionNum, questionText: question.questionText, options: question.options, correctAnswer: question.correctAnswer, difficulty: question.difficulty, points, selectedOption: timeoutResponse.selectedOption ?? null, isCorrect, wasSkipped: timeoutResponse.action === 'skip' },
                earlyExit: false,
              };
            }
          } catch (innerError) {
            if (!isCallbackTimeout(innerError)) throw innerError;

            // Double timeout — auto-skip
            qCtx.logger.info(`Q${questionNum}: Double timeout, auto-skipping`);
            await qCtx.step(`update-score-q${questionNum}-autoskip`, async () => {
              await ddb.send(new UpdateCommand({
                TableName: TABLE,
                Key: { PK: pk, SK: playerSK(participantId) },
                UpdateExpression: 'SET currentQuestion = :cq, statusDot = :dot',
                ExpressionAttributeValues: {
                  ':cq': questionNum,
                  ':dot': 'amber',
                },
              }));
              await publishToChannel({
                channel: `leaderboard/${sessionId}`,
                events: [{
                  type: 'player_update',
                  participantId,
                  totalScore: currentScore,
                  currentQuestion: questionNum,
                  statusDot: 'amber',
                  latestStatus: 'skipped',
                }],
              });
            });
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

    // Step 1: Read question package + session metadata
    const { questions, categoryMeta } = await context.step('read-session-data', async () => {
      const [packageResult, metaResult] = await Promise.all([
        ddb.send(new GetCommand({
          TableName: TABLE,
          Key: { PK: pk, SK: PACKAGE_SK },
        })),
        ddb.send(new GetCommand({
          TableName: TABLE,
          Key: { PK: pk, SK: METADATA_SK },
          ProjectionExpression: 'categoryName, categoryEmoji, categoryColor, #m',
          ExpressionAttributeNames: { '#m': 'mode' },
        })),
      ]);

      if (!packageResult.Item) throw new Error(`PACKAGE not found for session ${sessionId}`);

      return {
        questions: packageResult.Item.questions as Question[],
        categoryMeta: {
          categoryName: (metaResult.Item?.categoryName as string) ?? '',
          categoryEmoji: (metaResult.Item?.categoryEmoji as string) ?? '',
          categoryColor: (metaResult.Item?.categoryColor as string) ?? '',
          mode: (metaResult.Item?.mode as string) ?? '',
        },
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
          score: 0,
          currentQuestion: 0,
          statusDot: 'green',
          joinedAt: new Date().toISOString(),
          ttl: ttl24h(),
        },
      }));
    });

    // Step 3: Wait for game start
    // Include the callback token in join_ack so the CLIENT can wake us directly
    let startPayloadRaw: string;
    try {
      startPayloadRaw = await context.waitForCallback<string>(
        'wait-for-start',
        async (callbackToken) => {
          // Publish join_ack with the start callback token — client stores it
          await publishToChannel({
            channel: playerChannel,
            events: [{
              type: 'join_ack',
              sessionId,
              participantId,
              displayName,
              questionCount: questions.length,
              mode: categoryMeta.mode,
              categoryName: categoryMeta.categoryName,
              categoryEmoji: categoryMeta.categoryEmoji,
              categoryColor: categoryMeta.categoryColor,
              callbackToken, // Client uses this to wake POD at game start
            }],
          });
        },
        { timeout: { minutes: 35 } },
      );
    } catch (error) {
      if (error instanceof CallbackError) {
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
    context.logger.info('Start signal received', { action: startPayload.action });

    // If we received a non-start signal (e.g., game was cancelled), exit cleanly
    if (startPayload.action !== 'start') {
      context.logger.info('Received non-start signal, exiting', { action: startPayload.action });
      await context.step('write-cancelled-status', async () => {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: pk, SK: playerSK(participantId) },
          UpdateExpression: 'SET #s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus },
        }));
      });
      return { status: 'cancelled', participantId };
    }

    // Step 4: Update status to playing
    await context.step('update-status-playing', async () => {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: playerSK(participantId) },
        UpdateExpression: 'SET #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'playing' as PlayerStatus },
      }));
    });

    // Step 5: Question loop
    let totalScore = 0;
    const questionResults: QuestionResult[] = [];

    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
      const outcome = await processQuestion(
        context, questions[qIndex], qIndex, questions.length,
        totalScore, pk, participantId, sessionId, playerChannel,
      );

      totalScore += outcome.score;
      questionResults.push(outcome.result);

      if (outcome.earlyExit) {
        await context.step('write-final-status-early', async () => {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { PK: pk, SK: playerSK(participantId) },
            UpdateExpression: 'SET #s = :status, statusDot = :dot',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus, ':dot': 'checkmark' },
          }));
        });

        await context.step('publish-completion-early', async () => {
          await publishToChannel({
            channel: playerChannel,
            events: [{ type: 'game_complete', totalScore, questionsAnswered: qIndex + 1, totalQuestions: questions.length, questionResults }],
          });
          await publishToChannel({
            channel: `leaderboard/${sessionId}`,
            events: [{ type: 'player_completed', participantId, displayName, statusDot: 'checkmark' }],
          });
        });

        return { status: 'completed', totalScore, questionsAnswered: qIndex + 1 };
      }
    }

    // All questions answered
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

    // Wait for game-end signal
    try {
      await context.waitForCallback<CallbackPayload>(
        'wait-for-game-end',
        async (callbackToken) => {
          await publishToChannel({
            channel: playerChannel,
            events: [{ type: 'waiting_for_game_end', callbackToken }],
          });
        },
        { timeout: { seconds: 600 } },
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
        UpdateExpression: 'SET #s = :status, statusDot = :dot',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus, ':dot': 'checkmark' },
      }));
    });

    await context.step('publish-completion', async () => {
      await publishToChannel({
        channel: playerChannel,
        events: [{ type: 'game_complete', totalScore, questionsAnswered: questions.length, totalQuestions: questions.length, questionResults }],
      });
      await publishToChannel({
        channel: `leaderboard/${sessionId}`,
        events: [{ type: 'player_completed', participantId, displayName, statusDot: 'checkmark' }],
      });
    });

    context.logger.info('POD completed', { sessionId, participantId, totalScore });
    return { status: 'completed', totalScore, questionsAnswered: questions.length };
  },
);
