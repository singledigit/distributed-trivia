import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand as DocQueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import {
  sessionPK,
  categoryPK,
  METADATA_SK,
  PLAYER_PREFIX,
  ACTIVITY_PREFIX,
  generateUlid,
  validateMode,
  validateQuestionCount,
  validateTimeLimit,
  publishToChannel,
} from './shared/index';
import type {
  AppSyncEventsLambdaEvent,
  SessionMetadata,
  PlayerRecord,
  ActivityRecord,
  GameMode,
} from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const GAME_TABLE = process.env.GAME_TABLE_NAME!;
const QUESTIONS_TABLE = process.env.QUESTIONS_TABLE_NAME!;
const ODF_FUNCTION_ARN = process.env.ODF_FUNCTION_ARN!;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handler = async (event: AppSyncEventsLambdaEvent): Promise<unknown> => {
  console.log('Session Handler invoked', JSON.stringify(event));

  const operation = event.info?.operation ?? event.type;

  if (operation === 'PUBLISH' || operation === 'EVENT_PUBLISH') {
    const result = await handlePublish(event);
    console.log('Session Handler response', JSON.stringify(result));
    return result;
  }

  if (operation === 'SUBSCRIBE' || operation === 'EVENT_SUBSCRIBE') {
    return handleSubscribe(event);
  }

  return null;
};

// ---------------------------------------------------------------------------
// onPublish — dispatch by action
// ---------------------------------------------------------------------------

async function handlePublish(event: AppSyncEventsLambdaEvent) {
  const results = [];

  // Channel path is on the event info, not per-event
  const channelPath = event.info?.channel?.path ?? '';
  const segments = channelPath.split('/');
  const sessionId = segments[2] ?? segments[1] ?? ''; // /admin/{sessionId} → segments: ['', 'admin', '{sessionId}']

  for (const evt of event.events ?? []) {
    const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
    const { action } = payload;

    // If no action field, this is a server-originated event — pass through
    if (!action) {
      results.push({ id: evt.id, payload: typeof evt.payload === 'string' ? evt.payload : JSON.stringify(evt.payload) });
      continue;
    }

    let response: unknown;

    switch (action) {
      case 'create':
        response = await handleCreate(payload);
        break;
      case 'start':
        response = await handleStart(sessionId);
        break;
      case 'cancel':
        response = await handleCancel(sessionId);
        break;
      case 'status':
        response = await handleStatus(sessionId);
        break;
      default:
        response = { type: 'error', message: `Unknown action: ${action}` };
    }

    results.push({ id: evt.id, payload: JSON.stringify(response) });
  }

  return { events: results };
}

// ---------------------------------------------------------------------------
// create — validate inputs, invoke ODF async
// ---------------------------------------------------------------------------

interface CreatePayload {
  action: 'create';
  categoryId: string;
  mode: GameMode;
  questionCount?: number;
  timeLimitMinutes?: number;
}

/** Validate game config and invoke the Session Orchestrator ODF to create a new session. */
async function handleCreate(payload: CreatePayload) {
  const { categoryId, mode, questionCount, timeLimitMinutes } = payload;

  // Validate category exists
  const categoryResult = await ddb.send(
    new GetCommand({
      TableName: QUESTIONS_TABLE,
      Key: { PK: categoryPK(categoryId), SK: METADATA_SK },
    }),
  );

  if (!categoryResult.Item) {
    return { type: 'error', message: 'Category not found' };
  }

  // Validate mode
  const modeCheck = validateMode(mode);
  if (!modeCheck.valid) {
    return { type: 'error', message: modeCheck.error };
  }

  // Validate mode-specific params
  if (mode === 'question_count') {
    const countCheck = validateQuestionCount(questionCount);
    if (!countCheck.valid) {
      return { type: 'error', message: countCheck.error };
    }
  }

  if (mode === 'timed') {
    const timeCheck = validateTimeLimit(timeLimitMinutes);
    if (!timeCheck.valid) {
      return { type: 'error', message: timeCheck.error };
    }
  }

  // Generate session ID
  const sessionId = generateUlid();

  // Invoke ODF async (InvocationType: Event)
  await lambda.send(
    new InvokeCommand({
      FunctionName: ODF_FUNCTION_ARN,
      InvocationType: InvocationType.Event,
      Payload: JSON.stringify({
        sessionId,
        categoryId,
        mode,
        questionCount: mode === 'question_count' ? questionCount : undefined,
        timeLimitMinutes: mode === 'timed' ? timeLimitMinutes : undefined,
      }),
    }),
  );

  return { type: 'ack', sessionId };
}

// ---------------------------------------------------------------------------
// start — read ODF callback token, send start callback
// ---------------------------------------------------------------------------

/** Read the ODF callback token from METADATA and send a start signal. */
async function handleStart(sessionId: string) {
  const metadata = await getSessionMetadata(sessionId);
  if (!metadata) {
    return { type: 'error', message: 'Session not found' };
  }

  if (!metadata.odfCallbackToken) {
    return { type: 'error', message: 'Session is not ready to start (no callback token)' };
  }

  if (metadata.status !== 'waiting') {
    return { type: 'error', message: `Cannot start session in status: ${metadata.status}` };
  }

  await lambda.send(
    new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: metadata.odfCallbackToken,
      Result: new TextEncoder().encode(JSON.stringify({ action: 'start' })),
    }),
  );

  return { type: 'ack', action: 'start', sessionId };
}

// ---------------------------------------------------------------------------
// cancel — read ODF callback token, send cancel callback
// ---------------------------------------------------------------------------

/** Read the ODF callback token and send a cancel signal. Handles already-consumed tokens gracefully. */
async function handleCancel(sessionId: string) {
  const metadata = await getSessionMetadata(sessionId);
  if (!metadata) {
    return { type: 'error', message: 'Session not found' };
  }

  if (!metadata.odfCallbackToken) {
    return { type: 'error', message: 'Session is not ready (no callback token)' };
  }

  if (metadata.status === 'completed' || metadata.status === 'cancelled') {
    return { type: 'error', message: `Cannot cancel session in status: ${metadata.status}` };
  }

  try {
    await lambda.send(
      new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: metadata.odfCallbackToken,
        Result: new TextEncoder().encode(JSON.stringify({ action: 'cancel' })),
      }),
    );
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'CallbackTimeoutException' || errName === 'CallbackAlreadyCompletedException') {
      return { type: 'error', message: 'Game is already in progress or ended — cannot cancel via callback' };
    }
    throw err;
  }

  return { type: 'ack', action: 'cancel', sessionId };
}

// ---------------------------------------------------------------------------
// status — read METADATA, return current state
// ---------------------------------------------------------------------------

/** Return current session metadata (status, mode, config). */
async function handleStatus(sessionId: string) {
  const metadata = await getSessionMetadata(sessionId);
  if (!metadata) {
    return { type: 'error', message: 'Session not found' };
  }

  return {
    type: 'status',
    sessionId: metadata.sessionId,
    categoryId: metadata.categoryId,
    mode: metadata.mode,
    questionCount: metadata.questionCount,
    timeLimitMinutes: metadata.timeLimitMinutes,
    status: metadata.status,
    createdAt: metadata.createdAt,
  };
}

// ---------------------------------------------------------------------------
// onSubscribe — reconstruct full game state, publish snapshot
// ---------------------------------------------------------------------------

async function handleSubscribe(event: AppSyncEventsLambdaEvent) {
  const channelPath = event.info?.channel?.path;
  if (!channelPath) return null;

  // Use segments from AppSync (no leading empty string) or parse from path
  const appSyncSegments = event.info?.channel?.segments;
  const sessionId = appSyncSegments ? appSyncSegments[1] : channelPath.split('/').filter(Boolean)[1];

  if (!sessionId) return null;

  console.log('handleSubscribe', { channelPath, sessionId });

  // Query all records for this session (METADATA, PLAYER#, ACTIVITY#)
  const allItems = await queryAllSessionRecords(sessionId);

  // Separate records by type
  let metadata: SessionMetadata | undefined;
  const players: PlayerRecord[] = [];
  const activities: ActivityRecord[] = [];

  for (const item of allItems) {
    const sk = item.SK as string;
    if (sk === METADATA_SK) {
      metadata = item as unknown as SessionMetadata;
    } else if (sk.startsWith(PLAYER_PREFIX)) {
      players.push(item as unknown as PlayerRecord);
    } else if (sk.startsWith(ACTIVITY_PREFIX)) {
      activities.push(item as unknown as ActivityRecord);
    }
  }

  if (!metadata) return null;

  // Compute leaderboard state
  const leaderboard = computeLeaderboard(players, activities);

  // Build snapshot
  const snapshot = {
    type: 'snapshot',
    sessionId: metadata.sessionId,
    categoryId: metadata.categoryId,
    categoryName: metadata.categoryName ?? '',
    categoryEmoji: metadata.categoryEmoji ?? '',
    categoryColor: metadata.categoryColor ?? '',
    mode: metadata.mode,
    questionCount: metadata.questionCount,
    timeLimitMinutes: metadata.timeLimitMinutes,
    status: metadata.status,
    createdAt: metadata.createdAt,
    players: leaderboard,
  };

  // Determine which channel to publish to based on the subscription path
  const namespace = appSyncSegments ? appSyncSegments[0] : channelPath.split('/').filter(Boolean)[0];
  const publishChannel = `${namespace}/${sessionId}`;

  // Publish snapshot to the channel via HTTP
  await publishToChannel({
    channel: publishChannel,
    events: [snapshot],
  });

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: GAME_TABLE,
      Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
    }),
  );

  return (result.Item as SessionMetadata) ?? null;
}

async function queryAllSessionRecords(sessionId: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new DocQueryCommand({
        TableName: GAME_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': sessionPK(sessionId) },
        ExclusiveStartKey: lastKey,
      }),
    );

    if (result.Items) {
      items.push(...(result.Items as Record<string, unknown>[]));
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return items;
}

interface LeaderboardEntry {
  participantId: string;
  displayName: string;
  status: string;
  score: number;
  currentQuestion: number;
  statusDot: 'green' | 'amber' | 'red' | 'checkmark';
}

function computeLeaderboard(
  players: PlayerRecord[],
  activities: ActivityRecord[],
): LeaderboardEntry[] {
  // Group activities by participant
  const activityByParticipant = new Map<string, ActivityRecord[]>();
  for (const activity of activities) {
    const existing = activityByParticipant.get(activity.participantId) ?? [];
    existing.push(activity);
    activityByParticipant.set(activity.participantId, existing);
  }

  return players.map((player) => {
    const playerActivities = activityByParticipant.get(player.participantId) ?? [];

    // Total score: sum of points for all activities
    const score = playerActivities.reduce((sum, a) => sum + (a.points ?? 0), 0);

    // Current question: count distinct question numbers from activity SKs
    // ACTIVITY#{participantId}#{questionNum}#{seq}
    const questionNums = new Set<string>();
    for (const a of playerActivities) {
      const parts = a.SK.split('#');
      // parts: ['ACTIVITY', participantId, questionNum, seq]
      if (parts.length >= 3) {
        questionNums.add(parts[2]);
      }
    }
    const currentQuestion = questionNums.size;

    // Status dot based on latest activity
    let statusDot: LeaderboardEntry['statusDot'] = 'green';
    if (player.status === 'completed') {
      statusDot = 'checkmark';
    } else if (playerActivities.length > 0) {
      // Sort by timestamp descending to get latest
      const sorted = [...playerActivities].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      const latest = sorted[0];
      switch (latest.status) {
        case 'correct':
          statusDot = 'green';
          break;
        case 'extended':
        case 'skipped':
          statusDot = 'amber';
          break;
        case 'incorrect':
          statusDot = 'red';
          break;
      }
    }

    return {
      participantId: player.participantId,
      displayName: player.displayName,
      status: player.status,
      score,
      currentQuestion,
      statusDot,
    };
  });
}
