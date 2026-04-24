import type { DynamoDBStreamEvent, DynamoDBBatchResponse, DynamoDBRecord } from 'aws-lambda';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { publishToChannel, sessionPK, PLAYER_PREFIX, ACTIVITY_PREFIX } from './shared/index';
import type { PlayerRecord, ActivityRecord, ActivityStatus } from './shared/index';

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.GAME_TABLE_NAME!;

/**
 * Extract sessionId from PK value like "SESSION#abc123".
 */
function extractSessionId(pk: string): string {
  return pk.replace('SESSION#', '');
}

/**
 * Extract participantId from an ACTIVITY# SK.
 * SK format: ACTIVITY#{participantId}#{questionNum}#{seq}
 */
function extractParticipantIdFromActivitySK(sk: string): string {
  const parts = sk.split('#');
  return parts[1];
}

/**
 * Determine status dot color based on the latest activity status.
 * green = correct, amber = skipped/extended, red = incorrect
 */
function statusDotColor(status: ActivityStatus): string {
  switch (status) {
    case 'correct':
      return 'green';
    case 'skipped':
    case 'extended':
      return 'amber';
    case 'incorrect':
      return 'red';
    default:
      return 'green';
  }
}

/**
 * Query all PLAYER# records for a session.
 */
async function queryPlayers(sessionId: string): Promise<PlayerRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: sessionPK(sessionId) },
        ':prefix': { S: PLAYER_PREFIX },
      },
    }),
  );

  return (result.Items ?? []).map((item) => unmarshall(item) as PlayerRecord);
}

/**
 * Query all ACTIVITY# records for a specific player in a session.
 */
async function queryPlayerActivities(
  sessionId: string,
  participantId: string,
): Promise<ActivityRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: sessionPK(sessionId) },
        ':prefix': { S: `${ACTIVITY_PREFIX}${participantId}#` },
      },
    }),
  );

  return (result.Items ?? []).map((item) => unmarshall(item) as ActivityRecord);
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
    events: [
      {
        type: 'player_list',
        players: playerList,
      },
    ],
  });
}

/**
 * Handle ACTIVITY# INSERT — compute score/status and publish player state update.
 */
async function handleActivityInsert(
  sessionId: string,
  newActivity: ActivityRecord,
): Promise<void> {
  const participantId = newActivity.participantId;

  // Query ALL activity records for this player to compute total score
  const activities = await queryPlayerActivities(sessionId, participantId);

  // Total score = sum of points for all correct entries
  const totalScore = activities
    .filter((a) => a.status === 'correct')
    .reduce((sum, a) => sum + a.points, 0);

  // Current question number: count distinct questionIds with non-extended status
  const answeredQuestions = new Set(
    activities.filter((a) => a.status !== 'extended').map((a) => a.questionId),
  );
  const currentQuestion = answeredQuestions.size;

  // Status dot color based on the latest activity action
  const dotColor = statusDotColor(newActivity.status);

  await publishToChannel({
    channel: `leaderboard/${sessionId}`,
    events: [
      {
        type: 'player_update',
        participantId,
        totalScore,
        currentQuestion,
        statusDot: dotColor,
        latestStatus: newActivity.status,
      },
    ],
  });
}

/**
 * Handle PLAYER# MODIFY with status change to Completed.
 */
async function handlePlayerCompleted(
  sessionId: string,
  player: PlayerRecord,
): Promise<void> {
  await publishToChannel({
    channel: `leaderboard/${sessionId}`,
    events: [
      {
        type: 'player_completed',
        participantId: player.participantId,
        displayName: player.displayName,
        statusDot: 'checkmark',
      },
    ],
  });
}

/**
 * Process a single DDB stream record.
 */
async function processRecord(record: DynamoDBRecord): Promise<void> {
  const eventName = record.eventName;
  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;

  if (!newImage) return;

  const item = unmarshall(newImage as Record<string, any>);
  const pk = item.PK as string;
  const sk = item.SK as string;

  if (!pk || !sk) return;

  const sessionId = extractSessionId(pk);

  // PLAYER# INSERT — new player joined
  if (eventName === 'INSERT' && sk.startsWith(PLAYER_PREFIX)) {
    await handlePlayerInsert(sessionId);
    return;
  }

  // ACTIVITY# INSERT — new activity recorded
  if (eventName === 'INSERT' && sk.startsWith(ACTIVITY_PREFIX)) {
    await handleActivityInsert(sessionId, item as ActivityRecord);
    return;
  }

  // PLAYER# MODIFY — check for status change to Completed
  if (eventName === 'MODIFY' && sk.startsWith(PLAYER_PREFIX)) {
    const oldItem = oldImage ? unmarshall(oldImage as Record<string, any>) : null;
    const newStatus = item.status as string;
    const oldStatus = oldItem?.status as string | undefined;

    if (newStatus === 'completed' && oldStatus !== 'completed') {
      await handlePlayerCompleted(sessionId, item as PlayerRecord);
    }
    return;
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
