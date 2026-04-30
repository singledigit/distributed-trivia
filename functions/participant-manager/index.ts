import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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
  validateDisplayName,
  ttl24h,
  timed,
  emitLatency,
} from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const GAME_TABLE = process.env.GAME_TABLE_NAME!;
const POD_FUNCTION_ARN = process.env.POD_FUNCTION_ARN!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// join — idempotent: conditional write reserves the name, retry returns same ID
// ---------------------------------------------------------------------------

/** Deterministic SK for name reservation: NAMERES#{normalized_lowercase_name} */
function nameReservationSK(displayName: string): string {
  return `NAMERES#${displayName.trim().toLowerCase()}`;
}

async function handleJoin(
  payload: JoinPayload,
  sessionId: string,
  _channelPath: string,
): Promise<Record<string, unknown>> {
  const { displayName } = payload;

  // Validate display name format (1-20 chars after trim)
  const validation = validateDisplayName(displayName);
  if (!validation.valid) {
    return { type: 'error', message: validation.error };
  }

  const trimmedName = displayName.trim();
  const pk = sessionPK(sessionId);
  const sk = nameReservationSK(trimmedName);
  const participantId = generateUlid();

  // Atomic reservation — first write wins, no race window
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
      // Name already reserved — return the existing participantId (idempotent)
      const existing = await ddb.send(new GetCommand({
        TableName: GAME_TABLE,
        Key: { PK: pk, SK: sk },
        ProjectionExpression: 'participantId, displayName',
      }));

      if (existing.Item) {
        return {
          type: 'joined',
          sessionId,
          participantId: existing.Item.participantId as string,
          displayName: existing.Item.displayName as string,
        };
      }

      return { type: 'error', message: 'Display name is already taken' };
    }
    throw err;
  }

  // Reservation succeeded — start POD async
  await timed('lambda-invoke-pod', { sessionId, participantId }, () =>
    lambda.send(
      new InvokeCommand({
        FunctionName: POD_FUNCTION_ARN,
        InvocationType: InvocationType.Event,
        Payload: JSON.stringify({
          sessionId,
          participantId,
          displayName: trimmedName,
        }),
      }),
    ),
  );

  emitLatency('JoinPlayer', 0, 'participant-manager');

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

  try {
    await lambda.send(
      new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: callbackToken,
        Result: new TextEncoder().encode(JSON.stringify({ action, ...data })),
      }),
    );
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'CallbackAlreadyCompletedException' || errName === 'CallbackTimeoutException') {
      // Stale or expired token — the POD has moved on
      return { type: 'error', message: 'stale_token' };
    }
    throw err;
  }

  return { type: 'ack', action };
}
