import { withDurableExecution, DurableContext, CallbackError } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import {
  sessionPK,
  categoryPK,
  METADATA_SK,
  PACKAGE_SK,
  QUESTION_PREFIX,
  PLAYER_PREFIX,
  ttl24h,
  publishToChannel,
} from './shared/index';
import type { Question, GameMode, Difficulty, SessionMetadata, SessionPackage, PlayerRecord } from './shared/index';

// --- Types ---

interface SessionOrchestratorEvent {
  sessionId: string;
  categoryId: string;
  mode: GameMode;
  questionCount?: number;
  timeLimitMinutes?: number;
}

interface CallbackPayload {
  action: 'start' | 'cancel';
}

// --- Clients (created outside handler for reuse across replays) ---

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const GAME_TABLE = process.env.GAME_TABLE_NAME!;
const QUESTIONS_TABLE = process.env.QUESTIONS_TABLE_NAME!;

// --- Question selection helpers ---

/**
 * Select questions with a balanced 1:1:1 difficulty ratio, randomized.
 * If not enough questions of a difficulty, fill from others.
 */
function selectBalancedQuestions(allQuestions: Question[], count: number): Question[] {
  const byDifficulty: Record<Difficulty, Question[]> = { easy: [], medium: [], hard: [] };

  // Shuffle all questions first
  const shuffled = [...allQuestions].sort(() => Math.random() - 0.5);
  for (const q of shuffled) {
    byDifficulty[q.difficulty].push(q);
  }

  const perDifficulty = Math.floor(count / 3);
  const remainder = count % 3;

  const selected: Question[] = [];

  // Take equal amounts from each difficulty
  const difficulties: Difficulty[] = ['easy', 'medium', 'hard'];
  const remaining: Question[] = [];

  for (const diff of difficulties) {
    const take = Math.min(perDifficulty, byDifficulty[diff].length);
    selected.push(...byDifficulty[diff].splice(0, take));
    remaining.push(...byDifficulty[diff]);
  }

  // Fill remainder from whatever is left
  const shuffledRemaining = remaining.sort(() => Math.random() - 0.5);
  const needed = count - selected.length;
  selected.push(...shuffledRemaining.slice(0, needed));

  // Final shuffle so difficulties are mixed
  return selected.sort(() => Math.random() - 0.5);
}

// --- Handler ---

export const handler = withDurableExecution(
  async (event: SessionOrchestratorEvent, context: DurableContext): Promise<unknown> => {
    const { sessionId, categoryId, mode, questionCount, timeLimitMinutes } = event;
    context.logger.info('Session Orchestrator started', { sessionId, categoryId, mode });

    // ---------------------------------------------------------------
    // Step 1: Query questions and build session
    // ---------------------------------------------------------------
    const questions = await context.step('query-questions', async () => {
      const items: Question[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await ddb.send(new QueryCommand({
          TableName: QUESTIONS_TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {
            ':pk': categoryPK(categoryId),
            ':prefix': QUESTION_PREFIX,
          },
          ExclusiveStartKey: lastKey,
        }));
        if (result.Items) items.push(...(result.Items as Question[]));
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);
      return items;
    });

    // Read category name and emoji for theming
    const categoryMeta = await context.step('read-category-meta', async () => {
      const result = await ddb.send(new GetCommand({
        TableName: QUESTIONS_TABLE,
        Key: { PK: categoryPK(categoryId), SK: METADATA_SK },
        ProjectionExpression: 'categoryName, categoryEmoji, categoryColor',
      }));
      return {
        categoryName: (result.Item?.categoryName as string) ?? categoryId,
        categoryEmoji: (result.Item?.categoryEmoji as string) ?? '',
        categoryColor: (result.Item?.categoryColor as string) ?? '',
      };
    });

    // Determine how many questions to select
    const targetCount = mode === 'question_count'
      ? questionCount!
      : Math.min(timeLimitMinutes! * 10, 50); // 10 per minute, max 50

    const selectedQuestions = await context.step('select-questions', async () => {
      return selectBalancedQuestions(questions, Math.min(targetCount, questions.length));
    });

    // Guard: must have at least 1 question
    if (selectedQuestions.length === 0) {
      context.logger.error('No questions available for category', { categoryId });
      await context.step('cancel-no-questions', async () => {
        await publishToChannel({
          channel: `admin/${sessionId}`,
          events: [{ type: 'error', message: 'No questions available for this category' }],
        });
      });
      return { sessionId, status: 'failed', reason: 'no_questions' };
    }

    context.logger.info('Selected questions', { count: selectedQuestions.length });

    // ---------------------------------------------------------------
    // Step 2: Write METADATA + PACKAGE to GameTable
    // ---------------------------------------------------------------
    const now = await context.step('get-timestamp', async () => new Date().toISOString());
    const ttl = await context.step('get-ttl', async () => ttl24h());

    await context.step('write-metadata', async () => {
      const metadata: SessionMetadata = {
        PK: sessionPK(sessionId),
        SK: METADATA_SK,
        sessionId,
        categoryId,
        categoryName: categoryMeta.categoryName,
        categoryEmoji: categoryMeta.categoryEmoji,
        categoryColor: categoryMeta.categoryColor,
        mode,
        questionCount: selectedQuestions.length,
        timeLimitMinutes: timeLimitMinutes ?? 0,
        status: 'waiting',
        createdAt: now,
        ttl,
      };
      await ddb.send(new PutCommand({ TableName: GAME_TABLE, Item: metadata }));
    });

    await context.step('write-package', async () => {
      const pkg: SessionPackage = {
        PK: sessionPK(sessionId),
        SK: PACKAGE_SK,
        questions: selectedQuestions,
        ttl,
      };
      await ddb.send(new PutCommand({ TableName: GAME_TABLE, Item: pkg }));
    });

    // ---------------------------------------------------------------
    // Step 3: Publish session_created to admin channel
    // ---------------------------------------------------------------
    await context.step('publish-session-created', async () => {
      await publishToChannel({
        channel: `admin/${sessionId}`,
        events: [{ type: 'session_created', sessionId }],
      });
    });

    // ---------------------------------------------------------------
    // Step 4: Wait for start or cancel callback
    // ---------------------------------------------------------------
    let callbackResult: CallbackPayload;
    try {
      callbackResult = await context.waitForCallback<CallbackPayload>(
        'wait-for-start-or-cancel',
        async (callbackId) => {
          // Store the callback token on the METADATA record so Session Handler can find it
          await ddb.send(new UpdateCommand({
            TableName: GAME_TABLE,
            Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
            UpdateExpression: 'SET odfCallbackToken = :token, sessionReadyAt = :readyAt',
            ExpressionAttributeValues: { ':token': callbackId, ':readyAt': new Date().toISOString() },
          }));
        },
        { timeout: { minutes: 30 } }, // Auto-cancel if host doesn't start within 30 min
      );
    } catch (error) {
      if (error instanceof CallbackError) {
        context.logger.error('Callback error while waiting for start/cancel', { error: String(error) });
        // Treat as cancel (lobby timeout or error)
        await context.step('update-status-error', async () => {
          await ddb.send(new UpdateCommand({
            TableName: GAME_TABLE,
            Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
            UpdateExpression: 'SET #s = :status',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':status': 'cancelled' },
          }));
        });
        await context.step('broadcast-lobby-timeout', async () => {
          await publishToChannel({
            channel: `game/${sessionId}`,
            events: [{ type: 'game_cancelled', sessionId, reason: 'lobby_timeout' }],
          });
        });
        return { sessionId, status: 'cancelled', reason: 'callback_error' };
      }
      throw error;
    }

    // ---------------------------------------------------------------
    // Handle cancel
    // ---------------------------------------------------------------
    if (callbackResult.action === 'cancel') {
      context.logger.info('Game cancelled by host');

      await context.step('broadcast-cancel', async () => {
        await publishToChannel({
          channel: `game/${sessionId}`,
          events: [{ type: 'game_cancelled', sessionId }],
        });
      });

      await context.step('update-status-cancelled', async () => {
        await ddb.send(new UpdateCommand({
          TableName: GAME_TABLE,
          Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
          UpdateExpression: 'SET #s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': 'cancelled' },
        }));
      });

      return { sessionId, status: 'cancelled' };
    }

    // ---------------------------------------------------------------
    // Handle start
    // ---------------------------------------------------------------
    context.logger.info('Game starting');

    // Step: Scan PLAYER# records for callback tokens
    const players = await context.step('scan-players', async () => {
      const items: PlayerRecord[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await ddb.send(new QueryCommand({
          TableName: GAME_TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {
            ':pk': sessionPK(sessionId),
            ':prefix': PLAYER_PREFIX,
          },
          ExclusiveStartKey: lastKey,
        }));
        if (result.Items) items.push(...(result.Items as PlayerRecord[]));
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);
      return items;
    });

    // Guard: cannot start with zero players
    if (players.length === 0) {
      context.logger.warn('No players joined — cancelling game');
      await context.step('cancel-no-players', async () => {
        await ddb.send(new UpdateCommand({
          TableName: GAME_TABLE,
          Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
          UpdateExpression: 'SET #s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': 'cancelled' },
        }));
        await publishToChannel({
          channel: `game/${sessionId}`,
          events: [{ type: 'game_cancelled', sessionId, reason: 'no_players' }],
        });
      });
      return { sessionId, status: 'cancelled', reason: 'no_players' };
    }

    // Step: Compute start time (now + 5 seconds)
    const startTime = await context.step('compute-start-time', async () => {
      return new Date(Date.now() + 5000).toISOString();
    });

    // Map: Send start callback to all PODs in parallel
    if (players.length > 0) {
      const playersWithTokens = players.filter(p => p.podCallbackToken);

      if (playersWithTokens.length > 0) {
        await context.map(
          'send-start-to-pods',
          playersWithTokens,
          async (ctx, player, index) => {
            return await ctx.step(`start-pod-${player.participantId}`, async () => {
              await lambda.send(new SendDurableExecutionCallbackSuccessCommand({
                CallbackId: player.podCallbackToken!,
                Result: new TextEncoder().encode(JSON.stringify({ action: 'start', startTime })),
              }));
            });
          },
          { maxConcurrency: 10 },
        );
      }
    }

    // Step: Publish start time to game channel
    await context.step('publish-game-start', async () => {
      await publishToChannel({
        channel: `game/${sessionId}`,
        events: [{ type: 'game_started', sessionId, startTime }],
      });
    });

    // Step: Update METADATA status to in_progress + store new callback token for cancel
    // Use waitForCallback with timeout = game duration. Timeout = natural end. Callback = cancel.
    const timeoutMinutes = mode === 'timed' ? timeLimitMinutes! : 5; // 5 min hard cap for question_count

    let cancelledByHost = false;
    try {
      const endSignal = await context.waitForCallback<string>(
        'wait-for-game-end',
        async (callbackToken) => {
          // Store the new callback token on METADATA so Session Handler can send cancel
          await ddb.send(new UpdateCommand({
            TableName: GAME_TABLE,
            Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
            UpdateExpression: 'SET #s = :status, odfCallbackToken = :token, gameStartTime = :startTime',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':status': 'in_progress',
              ':token': callbackToken,
              ':startTime': startTime,
            },
          }));
        },
        { timeout: { minutes: timeoutMinutes } },
      );

      // If we get here, the host sent a cancel callback
      const parsed = typeof endSignal === 'string' ? JSON.parse(endSignal) : endSignal;
      if (parsed?.action === 'cancel') {
        cancelledByHost = true;
      }
    } catch (error: unknown) {
      // Timeout — game ended naturally
      // The error may be CallbackError or ChildContextError depending on the SDK version
      const errMsg = (error as { message?: string })?.message ?? '';
      if (errMsg.includes('timed out') || errMsg.includes('Callback') || (error instanceof CallbackError)) {
        context.logger.info('Game timer expired');
      } else {
        throw error;
      }
    }

    if (cancelledByHost) {
      // Broadcast cancel
      await context.step('broadcast-cancel-during-game', async () => {
        await publishToChannel({
          channel: `game/${sessionId}`,
          events: [{ type: 'game_cancelled', sessionId }],
        });
      });

      await context.step('update-status-cancelled-during-game', async () => {
        await ddb.send(new UpdateCommand({
          TableName: GAME_TABLE,
          Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
          UpdateExpression: 'SET #s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': 'cancelled' },
        }));
      });

      return { sessionId, status: 'cancelled' };
    }

    // Natural end — broadcast TIMES UP
    await context.step('broadcast-times-up', async () => {
      await publishToChannel({
        channel: `game/${sessionId}`,
        events: [{ type: 'times_up', sessionId }],
      });
    });

    // ---------------------------------------------------------------
    // Game end: update status to completed
    // ---------------------------------------------------------------
    await context.step('update-status-completed', async () => {
      await ddb.send(new UpdateCommand({
        TableName: GAME_TABLE,
        Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
        UpdateExpression: 'SET #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'completed' },
      }));
    });

    context.logger.info('Game completed', { sessionId });
    return { sessionId, status: 'completed' };
  },
);
