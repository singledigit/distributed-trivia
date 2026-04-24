import { withDurableExecution, DurableContext, CallbackError } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  sessionPK,
  PACKAGE_SK,
  playerSK,
  activitySK,
  ttl24h,
  calculateScore,
  publishToChannel,
} from './shared/index';
import type { Question, PlayerStatus, ActivityStatus } from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.GAME_TABLE_NAME!;

/** Parse a callback result — the SDK may return a JSON string that needs parsing */
function parseCallback<T>(raw: unknown): T {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return raw as T; }
  }
  return raw as T;
}

interface ParticipantOrchestratorEvent {
  sessionId: string;
  participantId: string;
  displayName: string;
}

interface CallbackPayload {
  action: 'start' | 'ready' | 'answer' | 'skip' | 'more_time' | 'complete';
  startTime?: string;
  selectedOption?: string;
}

export const handler = withDurableExecution(
  async (event: ParticipantOrchestratorEvent, context: DurableContext): Promise<unknown> => {
    const { sessionId, participantId, displayName } = event;
    const playerChannel = `player/${sessionId}/${participantId}`;
    const pk = sessionPK(sessionId);

    context.logger.info('POD started', { sessionId, participantId, displayName });

    // Step 1: Read PACKAGE from GameTable
    const questions: Question[] = await context.step('read-package', async () => {
      const result = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: PACKAGE_SK },
      }));
      if (!result.Item) {
        throw new Error(`PACKAGE not found for session ${sessionId}`);
      }
      return result.Item.questions as Question[];
    });

    // Step 2: Write PLAYER# record with initial callback token
    // The callback token will be set by the first waitForCallback
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

    // Step 3: Publish ack to player channel
    await context.step('publish-join-ack', async () => {
      await publishToChannel({
        channel: playerChannel,
        events: [{
          type: 'join_ack',
          sessionId,
          participantId,
          displayName,
          questionCount: questions.length,
        }],
      });
    });

    // Step 4: Wait for game start signal from ODF
    const startPayloadRaw = await context.waitForCallback<string>(
      'wait-for-start',
      async (callbackToken) => {
        // Store callback token on PLAYER# record so ODF can find it
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: pk, SK: playerSK(participantId) },
          UpdateExpression: 'SET podCallbackToken = :token',
          ExpressionAttributeValues: { ':token': callbackToken },
        }));
      },
    );

    // The callback result comes as a JSON string — parse it
    let startPayload: CallbackPayload;
    if (typeof startPayloadRaw === 'string') {
      startPayload = JSON.parse(startPayloadRaw);
    } else {
      startPayload = startPayloadRaw as unknown as CallbackPayload;
    }

    const startTime = startPayload.startTime;
    context.logger.info('Start payload received', { startTime });

    // Step 5+6: Wait for "ready" — publish start time + callback token together
    try {
      await context.waitForCallback<CallbackPayload>(
        'wait-for-ready',
        async (callbackToken) => {
          await publishToChannel({
            channel: playerChannel,
            events: [{
              type: 'game_starting',
              startTime,
              callbackToken,
            }],
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

    // Step 7: Update player status to playing
    await context.step('update-status-playing', async () => {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: playerSK(participantId) },
        UpdateExpression: 'SET #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'playing' as PlayerStatus },
      }));
    });

    // Step 8: Question loop
    let totalScore = 0;

    // Track per-question results for the post-game report
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
    const questionResults: QuestionResult[] = [];

    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
      const question = questions[qIndex];
      const questionNum = qIndex + 1;
      let seq = 1;
      let questionComplete = false;

      // Send the question to the player
      const sendQuestion = async (callbackToken: string) => {
        await publishToChannel({
          channel: playerChannel,
          events: [{
            type: 'question',
            questionNum,
            totalQuestions: questions.length,
            questionId: question.questionId,
            questionText: question.questionText,
            options: question.options,
            difficulty: question.difficulty,
            points: question.points,
            callbackToken,
            currentScore: totalScore,
          }],
        });
      };

      while (!questionComplete) {
        try {
          const responseRaw = await context.waitForCallback<CallbackPayload>(
            `wait-q${questionNum}-seq${seq}`,
            async (callbackToken) => {
              if (seq === 1) {
                // First time sending this question
                await sendQuestion(callbackToken);
              } else {
                // Re-sending after more_time
                await sendQuestion(callbackToken);
              }
            },
            { timeout: { seconds: 30 } },
          );
          const response = parseCallback<CallbackPayload>(responseRaw);

          if (response.action === 'complete') {
            // Game ended (timed mode — "TIMES UP" from game channel)
            await context.step(`write-final-status-early-q${questionNum}`, async () => {
              await ddb.send(new UpdateCommand({
                TableName: TABLE,
                Key: { PK: pk, SK: playerSK(participantId) },
                UpdateExpression: 'SET #s = :status',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus },
              }));
            });

            await context.step(`publish-completion-early-q${questionNum}`, async () => {
              await publishToChannel({
                channel: playerChannel,
                events: [{
                  type: 'game_complete',
                  totalScore,
                  questionsAnswered: qIndex,
                  totalQuestions: questions.length,
                  questionResults,
                }],
              });
            });

            return { status: 'completed', totalScore, questionsAnswered: qIndex };
          }

          if (response.action === 'more_time') {
            // Write ACTIVITY# record for extension
            await context.step(`write-activity-q${questionNum}-seq${seq}-extended`, async () => {
              await ddb.send(new PutCommand({
                TableName: TABLE,
                Item: {
                  PK: pk,
                  SK: activitySK(participantId, questionNum, seq),
                  participantId,
                  questionId: question.questionId,
                  answer: null,
                  status: 'extended' as ActivityStatus,
                  points: 0,
                  timestamp: new Date().toISOString(),
                  ttl: ttl24h(),
                },
              }));
            });
            seq++;
            // Loop continues — will re-send question with new callback token
            continue;
          }

          if (response.action === 'answer' || response.action === 'skip') {
            const isCorrect = response.action === 'answer' &&
              response.selectedOption === question.correctAnswer;
            const points = response.action === 'skip'
              ? 0
              : calculateScore(question.difficulty, isCorrect);
            const activityStatus: ActivityStatus = response.action === 'skip'
              ? 'skipped'
              : isCorrect ? 'correct' : 'incorrect';

            totalScore += points;

            // Write ACTIVITY# record
            await context.step(`write-activity-q${questionNum}-seq${seq}`, async () => {
              await ddb.send(new PutCommand({
                TableName: TABLE,
                Item: {
                  PK: pk,
                  SK: activitySK(participantId, questionNum, seq),
                  participantId,
                  questionId: question.questionId,
                  answer: response.selectedOption ?? null,
                  status: activityStatus,
                  points,
                  timestamp: new Date().toISOString(),
                  ttl: ttl24h(),
                },
              }));
            });

            // Track result for post-game report
            questionResults.push({
              questionNum,
              questionText: question.questionText,
              options: question.options,
              correctAnswer: question.correctAnswer,
              difficulty: question.difficulty,
              points,
              selectedOption: response.selectedOption ?? null,
              isCorrect,
              wasSkipped: response.action === 'skip',
            });

            questionComplete = true;
          }
        } catch (error) {
          if (error instanceof CallbackError) {
            // Timeout — send timeout prompt with more_time and skip options
            context.logger.info(`Question ${questionNum} timed out for ${participantId}`);

            // Write timeout activity
            await context.step(`write-activity-q${questionNum}-seq${seq}-timeout`, async () => {
              await ddb.send(new PutCommand({
                TableName: TABLE,
                Item: {
                  PK: pk,
                  SK: activitySK(participantId, questionNum, seq),
                  participantId,
                  questionId: question.questionId,
                  answer: null,
                  status: 'extended' as ActivityStatus,
                  points: 0,
                  timestamp: new Date().toISOString(),
                  ttl: ttl24h(),
                },
              }));
            });

            seq++;

            // Send timeout prompt with new callback token
            try {
              const timeoutResponseRaw = await context.waitForCallback<CallbackPayload>(
                `wait-q${questionNum}-timeout-seq${seq}`,
                async (callbackToken) => {
                  await publishToChannel({
                    channel: playerChannel,
                    events: [{
                      type: 'timeout_prompt',
                      questionNum,
                      questionId: question.questionId,
                      callbackToken,
                    }],
                  });
                },
                { timeout: { seconds: 30 } },
              );
              const timeoutResponse = parseCallback<CallbackPayload>(timeoutResponseRaw);

              if (timeoutResponse.action === 'more_time') {
                seq++;
                // Loop continues — will re-send question
                continue;
              }

              if (timeoutResponse.action === 'skip') {
                // Write skip activity
                await context.step(`write-activity-q${questionNum}-seq${seq}-skip`, async () => {
                  await ddb.send(new PutCommand({
                    TableName: TABLE,
                    Item: {
                      PK: pk,
                      SK: activitySK(participantId, questionNum, seq),
                      participantId,
                      questionId: question.questionId,
                      answer: null,
                      status: 'skipped' as ActivityStatus,
                      points: 0,
                      timestamp: new Date().toISOString(),
                      ttl: ttl24h(),
                    },
                  }));
                });

                questionResults.push({
                  questionNum,
                  questionText: question.questionText,
                  options: question.options,
                  correctAnswer: question.correctAnswer,
                  difficulty: question.difficulty,
                  points: 0,
                  selectedOption: null,
                  isCorrect: false,
                  wasSkipped: true,
                });

                questionComplete = true;
              }

              if (timeoutResponse.action === 'complete') {
                await context.step(`write-final-status-timeout-q${questionNum}`, async () => {
                  await ddb.send(new UpdateCommand({
                    TableName: TABLE,
                    Key: { PK: pk, SK: playerSK(participantId) },
                    UpdateExpression: 'SET #s = :status',
                    ExpressionAttributeNames: { '#s': 'status' },
                    ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus },
                  }));
                });

                await context.step(`publish-completion-timeout-q${questionNum}`, async () => {
                  await publishToChannel({
                    channel: playerChannel,
                    events: [{
                      type: 'game_complete',
                      totalScore,
                      questionsAnswered: qIndex,
                      totalQuestions: questions.length,
                      questionResults,
                    }],
                  });
                });

                return { status: 'completed', totalScore, questionsAnswered: qIndex };
              }
            } catch (innerError) {
              if (innerError instanceof CallbackError) {
                // Double timeout — auto-skip this question
                context.logger.info(`Question ${questionNum} double-timed out, auto-skipping`);
                await context.step(`write-activity-q${questionNum}-seq${seq}-autoskip`, async () => {
                  await ddb.send(new PutCommand({
                    TableName: TABLE,
                    Item: {
                      PK: pk,
                      SK: activitySK(participantId, questionNum, seq),
                      participantId,
                      questionId: question.questionId,
                      answer: null,
                      status: 'skipped' as ActivityStatus,
                      points: 0,
                      timestamp: new Date().toISOString(),
                      ttl: ttl24h(),
                    },
                  }));
                });

                questionResults.push({
                  questionNum,
                  questionText: question.questionText,
                  options: question.options,
                  correctAnswer: question.correctAnswer,
                  difficulty: question.difficulty,
                  points: 0,
                  selectedOption: null,
                  isCorrect: false,
                  wasSkipped: true,
                });

                questionComplete = true;
              } else {
                throw innerError;
              }
            }
          } else {
            throw error;
          }
        }
      }
    }

    // All questions answered — write PLAYER# status to "completed"
    await context.step('write-final-status', async () => {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: playerSK(participantId) },
        UpdateExpression: 'SET #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'completed' as PlayerStatus },
      }));
    });

    // Publish completion to player channel
    await context.step('publish-completion', async () => {
      await publishToChannel({
        channel: playerChannel,
        events: [{
          type: 'game_complete',
          totalScore,
          questionsAnswered: questions.length,
          totalQuestions: questions.length,
          questionResults,
        }],
      });
    });

    context.logger.info('POD completed', { sessionId, participantId, totalScore });

    return { status: 'completed', totalScore, questionsAnswered: questions.length };
  },
);
