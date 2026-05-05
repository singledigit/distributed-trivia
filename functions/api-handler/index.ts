/**
 * REST API Handler
 *
 * Provides synchronous request/response endpoints for operations that don't
 * need real-time push. WebSocket (AppSync Events) remains for live updates.
 *
 * Routes:
 *   GET  /api/categories                  — list all categories (admin, Cognito auth)
 *   POST /api/sessions                    — create a new game session (admin, Cognito auth)
 *   GET  /api/sessions/{id}               — get session snapshot/leaderboard (public, API key)
 *   POST /api/sessions/{id}/start         — start a game (admin, Cognito auth)
 *   POST /api/sessions/{id}/cancel        — cancel a game (admin, Cognito auth)
 *   POST /api/sessions/{id}/join          — join a game (public, API key)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
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
  QUESTION_PREFIX,
  generateUlid,
  validateMode,
  validateQuestionCount,
  validateTimeLimit,
  validateDisplayName,
  paginatedQuery,
  ttl24h,
} from './shared/index';
import type {
  SessionMetadata,
  PlayerRecord,
} from './shared/index';

// --- Clients ---

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const GAME_TABLE = process.env.GAME_TABLE_NAME!;
const QUESTIONS_TABLE = process.env.QUESTIONS_TABLE_NAME!;
const ODF_FUNCTION_ARN = process.env.ODF_FUNCTION_ARN!;
const POD_FUNCTION_ARN = process.env.POD_FUNCTION_ARN!;

// --- Types ---

interface APIGatewayEvent {
  routeKey: string;
  pathParameters?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
  requestContext?: {
    authorizer?: {
      jwt?: { claims?: Record<string, string> };
    };
  };
}

interface APIResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// --- Main handler ---

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  console.log('API Handler', JSON.stringify(event));

  const routeKey = event.routeKey;

  try {
    switch (routeKey) {
      case 'GET /api/categories':
        return await handleListCategories();
      case 'POST /api/sessions':
        return await handleCreateSession(event);
      case 'GET /api/sessions/{id}':
        return await handleGetSession(event);
      case 'POST /api/sessions/{id}/start':
        return await handleStartSession(event);
      case 'POST /api/sessions/{id}/cancel':
        return await handleCancelSession(event);
      case 'POST /api/sessions/{id}/join':
        return await handleJoinSession(event);
      default:
        return respond(404, { error: 'Not found' });
    }
  } catch (err) {
    console.error('Unhandled error', err);
    return respond(500, { error: 'Internal server error' });
  }
};

// --- Route handlers ---

async function handleListCategories(): Promise<APIResponse> {
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new ScanCommand({
      TableName: QUESTIONS_TABLE,
      ProjectionExpression: 'PK, SK, categoryId, categoryName, categoryEmoji',
      ExclusiveStartKey: lastKey,
    }));
    if (result.Items) allItems.push(...(result.Items as Record<string, unknown>[]));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const metadataMap = new Map<string, Record<string, unknown>>();
  const questionCounts = new Map<string, number>();

  for (const item of allItems) {
    const pk = item.PK as string;
    const sk = item.SK as string;
    if (sk === METADATA_SK) {
      metadataMap.set(pk, item);
    } else if (sk.startsWith(QUESTION_PREFIX)) {
      questionCounts.set(pk, (questionCounts.get(pk) ?? 0) + 1);
    }
  }

  const categories = [...metadataMap.entries()]
    .map(([pk, item]) => ({
      categoryId: item.categoryId as string,
      categoryName: item.categoryName as string,
      categoryEmoji: (item.categoryEmoji as string) ?? '',
      questionCount: questionCounts.get(pk) ?? 0,
    }))
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName));

  return respond(200, { categories });
}

async function handleCreateSession(event: APIGatewayEvent): Promise<APIResponse> {
  const body = parseBody(event);
  if (!body) return respond(400, { error: 'Invalid request body' });

  const { categoryId, mode, questionCount, timeLimitMinutes, sessionId: clientSessionId } = body;

  if (!categoryId) return respond(400, { error: 'categoryId is required' });

  const modeValidation = validateMode(mode);
  if (!modeValidation.valid) return respond(400, { error: modeValidation.error });

  if (mode === 'question_count') {
    const qcValidation = validateQuestionCount(questionCount);
    if (!qcValidation.valid) return respond(400, { error: qcValidation.error });
  }

  if (mode === 'timed') {
    const tlValidation = validateTimeLimit(timeLimitMinutes);
    if (!tlValidation.valid) return respond(400, { error: tlValidation.error });
  }

  const sessionId = (clientSessionId as string) || generateUlid();

  // Invoke ODF async
  await lambda.send(new InvokeCommand({
    FunctionName: ODF_FUNCTION_ARN,
    InvocationType: InvocationType.Event,
    Payload: JSON.stringify({
      sessionId,
      categoryId,
      mode,
      questionCount: mode === 'question_count' ? questionCount : undefined,
      timeLimitMinutes: mode === 'timed' ? timeLimitMinutes : undefined,
    }),
  }));

  return respond(201, { sessionId });
}

async function handleGetSession(event: APIGatewayEvent): Promise<APIResponse> {
  const sessionId = event.pathParameters?.id;
  if (!sessionId) return respond(400, { error: 'Session ID is required' });

  // Query all records for this session (METADATA + PLAYER# records)
  const allItems = await paginatedQuery(ddb, {
    TableName: GAME_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': sessionPK(sessionId) },
  });

  let metadata: SessionMetadata | undefined;
  const players: PlayerRecord[] = [];

  for (const item of allItems) {
    const sk = item.SK as string;
    if (sk === METADATA_SK) {
      metadata = item as unknown as SessionMetadata;
    } else if (sk.startsWith(PLAYER_PREFIX)) {
      players.push(item as unknown as PlayerRecord);
    }
  }

  if (!metadata) return respond(404, { error: 'Session not found' });

  // Build leaderboard from PLAYER# records directly
  const leaderboard = players.map((p) => ({
    participantId: p.participantId,
    displayName: p.displayName,
    status: p.status,
    score: (p as unknown as Record<string, unknown>).score as number ?? 0,
    currentQuestion: (p as unknown as Record<string, unknown>).currentQuestion as number ?? 0,
    statusDot: ((p as unknown as Record<string, unknown>).statusDot as string) ?? 'green',
  }));

  return respond(200, {
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
    gameStartTime: (metadata as Record<string, unknown>).gameStartTime ?? '',
    players: leaderboard,
  });
}

async function handleStartSession(event: APIGatewayEvent): Promise<APIResponse> {
  const sessionId = event.pathParameters?.id;
  if (!sessionId) return respond(400, { error: 'Session ID is required' });

  // Retry up to 3 times with backoff — token may not be written yet
  let metadata: SessionMetadata | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    metadata = await getSessionMetadata(sessionId);
    if (metadata?.odfCallbackToken) break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }

  if (!metadata) return respond(404, { error: 'Session not found' });
  if (!metadata.odfCallbackToken) return respond(409, { error: 'Session is not ready to start yet — try again in a moment' });
  if (metadata.status !== 'waiting') return respond(409, { error: `Cannot start session in status: ${metadata.status}` });

  try {
    await lambda.send(new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: metadata.odfCallbackToken,
      Result: new TextEncoder().encode(JSON.stringify({ action: 'start' })),
    }));
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'CallbackTimeoutException' || errName === 'CallbackAlreadyCompletedException') {
      return respond(409, { error: 'Game has already been started or cancelled' });
    }
    throw err;
  }

  return respond(200, { status: 'starting', sessionId });
}

async function handleCancelSession(event: APIGatewayEvent): Promise<APIResponse> {
  const sessionId = event.pathParameters?.id;
  if (!sessionId) return respond(400, { error: 'Session ID is required' });

  const metadata = await getSessionMetadata(sessionId);
  if (!metadata) return respond(404, { error: 'Session not found' });
  if (!metadata.odfCallbackToken) return respond(409, { error: 'Session is not ready (no callback token)' });
  if (metadata.status === 'completed' || metadata.status === 'cancelled') {
    return respond(409, { error: `Cannot cancel session in status: ${metadata.status}` });
  }

  try {
    await lambda.send(new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: metadata.odfCallbackToken,
      Result: new TextEncoder().encode(JSON.stringify({ action: 'cancel' })),
    }));
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'CallbackTimeoutException' || errName === 'CallbackAlreadyCompletedException') {
      return respond(409, { error: 'Game is already in progress or ended — cannot cancel via callback' });
    }
    throw err;
  }

  return respond(200, { status: 'cancelled', sessionId });
}

async function handleJoinSession(event: APIGatewayEvent): Promise<APIResponse> {
  const sessionId = event.pathParameters?.id;
  if (!sessionId) return respond(400, { error: 'Session ID is required' });

  const body = parseBody(event);
  if (!body) return respond(400, { error: 'Invalid request body' });

  const { displayName, participantId: clientParticipantId } = body;
  const validation = validateDisplayName(displayName);
  if (!validation.valid) return respond(400, { error: validation.error });

  const trimmedName = (displayName as string).trim();
  const pk = sessionPK(sessionId);
  const sk = `NAMERES#${trimmedName.toLowerCase()}`;
  const participantId = (clientParticipantId as string) || generateUlid();

  // Atomic name reservation
  try {
    await ddb.send(new PutCommand({
      TableName: GAME_TABLE,
      Item: {
        PK: pk,
        SK: sk,
        participantId,
        displayName: trimmedName,
        ttl: ttl24h(),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'ConditionalCheckFailedException') {
      // Name already reserved — check if it's the same player retrying (idempotent)
      const existing = await ddb.send(new GetCommand({
        TableName: GAME_TABLE,
        Key: { PK: pk, SK: sk },
        ProjectionExpression: 'participantId, displayName',
      }));
      if (existing.Item && existing.Item.participantId === participantId) {
        // Same player retrying — idempotent success
        return respond(200, {
          sessionId,
          participantId: existing.Item.participantId as string,
          displayName: existing.Item.displayName as string,
        });
      }
      return respond(409, { error: 'Display name is already taken' });
    }
    throw err;
  }

  // Start POD async
  await lambda.send(new InvokeCommand({
    FunctionName: POD_FUNCTION_ARN,
    InvocationType: InvocationType.Event,
    Payload: JSON.stringify({ sessionId, participantId, displayName: trimmedName }),
  }));

  return respond(201, { sessionId, participantId, displayName: trimmedName });
}

// --- Helpers ---

function respond(statusCode: number, body: unknown): APIResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event: APIGatewayEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

async function getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  const result = await ddb.send(new GetCommand({
    TableName: GAME_TABLE,
    Key: { PK: sessionPK(sessionId), SK: METADATA_SK },
  }));
  return (result.Item as SessionMetadata) ?? null;
}
