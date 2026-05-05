/**
 * Stream Handler — DDB Streams trigger
 *
 * Watches GameTable for:
 * - PLAYER# INSERT → publishes player_list to leaderboard channel (new join)
 *
 * Score updates and player_completed are now published directly by the POD.
 * This handler only handles join notifications.
 */

import type { DynamoDBStreamEvent, DynamoDBBatchResponse, DynamoDBRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { publishToChannel, sessionPK, PLAYER_PREFIX, paginatedQuery } from './shared/index';
import type { PlayerRecord } from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.GAME_TABLE_NAME!;

function extractSessionId(pk: string): string {
  return pk.replace('SESSION#', '');
}

async function queryPlayers(sessionId: string): Promise<PlayerRecord[]> {
  return paginatedQuery<PlayerRecord>(ddb, {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': sessionPK(sessionId),
      ':prefix': PLAYER_PREFIX,
    },
  });
}

/**
 * Handle PLAYER# INSERT — publish updated player list to leaderboard.
 */
async function handlePlayerInsert(sessionId: string): Promise<void> {
  const players = await queryPlayers(sessionId);

  const playerList = players.map((p) => ({
    participantId: p.participantId,
    displayName: p.displayName,
    status: p.status,
    joinedAt: p.joinedAt,
  }));

  await publishToChannel({
    channel: `leaderboard/${sessionId}`,
    events: [{ type: 'player_list', players: playerList }],
  });
}

async function processRecord(record: DynamoDBRecord): Promise<void> {
  const eventName = record.eventName;
  const newImage = record.dynamodb?.NewImage;

  if (!newImage) return;

  const item = unmarshall(newImage as Record<string, any>);
  const pk = item.PK as string;
  const sk = item.SK as string;

  if (!pk || !sk) return;

  const sessionId = extractSessionId(pk);

  // PLAYER# INSERT — new player joined
  if (eventName === 'INSERT' && sk.startsWith(PLAYER_PREFIX)) {
    await handlePlayerInsert(sessionId);
  }
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  console.log('Stream Handler invoked', JSON.stringify(event));

  const batchItemFailures: DynamoDBBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error('Failed to process record', record.eventID, error);
      if (record.eventID) {
        batchItemFailures.push({ itemIdentifier: record.eventID });
      }
    }
  }

  return { batchItemFailures };
};
