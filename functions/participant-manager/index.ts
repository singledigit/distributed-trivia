import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import type { AppSyncEventsLambdaEvent } from './shared/index';
import {
  generateUlid,
  sessionPK,
  PLAYER_PREFIX,
  validateDisplayName,
} from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const GAME_TABLE = process.env.GAME_TABLE_NAME!;
const POD_FUNCTION_ARN = process.env.POD_FUNCTION_ARN!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlayerSummary {
  displayName: string;
}

interface JoinPayload {
  action: 'join';
  displayName: string;
}

interface CallbackPayload {
  action: 'answer' | 'skip' | 'more_time' | 'ready' | 'complete';
  callbackToken: string;
  [key: string]: unknown;
}

type PlayerPayload = JoinPayload | CallbackPayload;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handler = async (
  event: AppSyncEventsLambdaEvent,
): Promise<unknown> => {
  console.log('Participant Manager invoked', JSON.stringify(event));

  const operation = event.info?.operation ?? event.type;
  if ((operation !== 'PUBLISH' && operation !== 'EVENT_PUBLISH') || !event.events) {
    return { events: [] };
  }

  const channelPath = event.info?.channel?.path ?? '';
  const segments = channelPath.split('/');
  // /player/{sessionId}/{participantId} → ['', 'player', sessionId, participantId]
  const sessionId = segments[2] ?? '';

  const results = await Promise.all(
    event.events.map(async (evt) => {
      try {
        const payload: PlayerPayload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload as unknown as PlayerPayload;
        const { action } = payload;

        // If no action field, this is a server-originated event (e.g., from POD publishing to player channel)
        // Pass it through unchanged
        if (!action) {
          return {
            id: evt.id,
            payload: typeof evt.payload === 'string' ? evt.payload : JSON.stringify(evt.payload),
          };
        }

        let response: unknown;

        switch (action) {
          case 'join':
            response = await handleJoin(payload as JoinPayload, sessionId, channelPath);
            break;

          case 'answer':
          case 'skip':
          case 'more_time':
          case 'ready':
          case 'complete':
            response = await handleCallback(payload as CallbackPayload);
            break;

          default:
            response = { type: 'error', message: `Unknown action: ${action}` };
        }

        return {
          id: evt.id,
          payload: JSON.stringify(response),
        };
      } catch (error) {
        console.error('Error processing event', error);
        return {
          id: evt.id,
          payload: JSON.stringify({
            type: 'error',
            message: 'Internal error processing request',
          }),
        };
      }
    }),
  );

  return { events: results };
};

// ---------------------------------------------------------------------------
// join — validate display name, check uniqueness, start POD async
// ---------------------------------------------------------------------------

async function handleJoin(
  payload: JoinPayload,
  sessionId: string,
  channelPath: string,
): Promise<Record<string, unknown>> {
  const { displayName } = payload;

  // Validate display name format (1-20 chars after trim)
  const validation = validateDisplayName(displayName);
  if (!validation.valid) {
    return { type: 'error', message: validation.error };
  }

  const trimmedName = displayName.trim();

  // Check uniqueness within session by querying PLAYER# records
  const existingPlayers = await getPlayersForSession(sessionId);
  if (isNameTaken(existingPlayers, trimmedName)) {
    return { type: 'error', message: 'Display name is already taken' };
  }

  // Generate participant ID (ULID)
  const participantId = generateUlid();

  // Start POD async (InvocationType: Event)
  await lambda.send(
    new InvokeCommand({
      FunctionName: POD_FUNCTION_ARN,
      InvocationType: InvocationType.Event,
      Payload: JSON.stringify({
        sessionId,
        participantId,
        displayName: trimmedName,
      }),
    }),
  );

  return {
    type: 'joined',
    sessionId,
    participantId,
    displayName: trimmedName,
  };
}

// ---------------------------------------------------------------------------
// callback — route answer/skip/more_time/ready/complete to POD
// ---------------------------------------------------------------------------

async function handleCallback(
  payload: CallbackPayload,
): Promise<Record<string, unknown>> {
  const { action, callbackToken, ...data } = payload;

  // Send callback to POD via SendDurableExecutionCallbackSuccess
  await lambda.send(
    new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: callbackToken,
      Result: new TextEncoder().encode(JSON.stringify({ action, ...data })),
    }),
  );

  return { type: 'ack', action };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Query all PLAYER# records for a session to check display name uniqueness.
 */
async function getPlayersForSession(sessionId: string): Promise<PlayerSummary[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: GAME_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': sessionPK(sessionId),
        ':prefix': PLAYER_PREFIX,
      },
      ProjectionExpression: 'displayName',
    }),
  );

  return (result.Items ?? []) as PlayerSummary[];
}

/**
 * Check if a display name is already taken (case-insensitive).
 */
function isNameTaken(players: PlayerSummary[], name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return players.some((p) => p.displayName.trim().toLowerCase() === normalized);
}
