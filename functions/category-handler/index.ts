/**
 * Category Handler Lambda
 *
 * Manages trivia categories: list, create (kicks off ODF), rename, delete.
 * Sits behind the categories/ AppSync Events namespace (Cognito auth).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from '@aws-sdk/client-lambda';
import type { AppSyncEventsLambdaEvent } from './shared/index';
import { categoryPK, METADATA_SK, QUESTION_PREFIX } from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const QUESTIONS_TABLE = process.env.QUESTIONS_TABLE_NAME!;
const CATEGORY_CREATOR_ARN = process.env.CATEGORY_CREATOR_ARN!;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategoryPayload {
  action: string;
  categoryId?: string;
  categoryName?: string;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handler = async (event: AppSyncEventsLambdaEvent): Promise<unknown> => {
  console.log('Category Handler invoked', JSON.stringify(event));

  const operation = event.info?.operation ?? event.type;

  if (operation === 'PUBLISH' || operation === 'EVENT_PUBLISH') {
    return handlePublish(event);
  }

  // No onSubscribe handler needed — categories are fetched via publish
  return { events: [] };
};

// ---------------------------------------------------------------------------
// onPublish — dispatch by action
// ---------------------------------------------------------------------------

async function handlePublish(event: AppSyncEventsLambdaEvent) {
  const results = [];

  for (const evt of event.events ?? []) {
    const payload: CategoryPayload = typeof evt.payload === 'string'
      ? JSON.parse(evt.payload)
      : evt.payload as unknown as CategoryPayload;
    const { action } = payload;

    // Pass through server-originated events
    if (!action) {
      results.push({
        id: evt.id,
        payload: typeof evt.payload === 'string' ? evt.payload : JSON.stringify(evt.payload),
      });
      continue;
    }

    let response: unknown;

    switch (action) {
      case 'list':
        response = await handleList();
        break;
      case 'create':
        response = await handleCreate(payload);
        break;
      case 'rename':
        response = await handleRename(payload);
        break;
      case 'delete':
        response = await handleDelete(payload);
        break;
      case 'expand':
        response = await handleExpand(payload);
        break;
      default:
        response = { type: 'error', message: `Unknown action: ${action}` };
    }

    results.push({ id: evt.id, payload: JSON.stringify(response) });
  }

  return { events: results };
}

// ---------------------------------------------------------------------------
// list — return all categories sorted alphabetically
// ---------------------------------------------------------------------------

/** Scan QuestionsTable for all category METADATA records with question counts, return sorted alphabetically. */
async function handleList() {
  // Scan all items to get both METADATA and QUESTION counts
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

  // Group: count questions per category, collect metadata
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

  return { type: 'categories', categories };
}

// ---------------------------------------------------------------------------
// create — validate name, invoke Category Creator ODF async
// ---------------------------------------------------------------------------

/** Validate category name and invoke the Category Creator ODF async. */
async function handleCreate(payload: CategoryPayload) {
  const name = payload.categoryName?.trim();
  if (!name || name.length < 2) return { type: 'error', message: 'Category name must be at least 2 characters' };
  if (name.length > 100) return { type: 'error', message: 'Category name must be 100 characters or less' };

  await lambda.send(new InvokeCommand({
    FunctionName: CATEGORY_CREATOR_ARN,
    InvocationType: InvocationType.Event,
    Payload: JSON.stringify({
      categoryName: name,
      adminChannel: '/categories/default',
    }),
  }));

  return { type: 'ack', action: 'create', categoryName: name };
}

// ---------------------------------------------------------------------------
// rename — update category METADATA record
// ---------------------------------------------------------------------------

/** Update the categoryName on an existing METADATA record. */
async function handleRename(payload: CategoryPayload) {
  const { categoryId, categoryName } = payload;
  if (!categoryId) return { type: 'error', message: 'categoryId is required' };

  const name = categoryName?.trim();
  if (!name || name.length < 2) return { type: 'error', message: 'Category name must be at least 2 characters' };
  if (name.length > 100) return { type: 'error', message: 'Category name must be 100 characters or less' };

  await ddb.send(new UpdateCommand({
    TableName: QUESTIONS_TABLE,
    Key: { PK: categoryPK(categoryId), SK: METADATA_SK },
    UpdateExpression: 'SET categoryName = :name',
    ExpressionAttributeValues: { ':name': name },
    ConditionExpression: 'attribute_exists(PK)',
  }));

  return { type: 'ack', action: 'rename', categoryId, categoryName: name };
}

// ---------------------------------------------------------------------------
// delete — remove category METADATA + all QUESTION# records
// ---------------------------------------------------------------------------

/** Delete a category and all its QUESTION# records from QuestionsTable. */
async function handleDelete(payload: CategoryPayload) {
  const { categoryId } = payload;
  if (!categoryId) return { type: 'error', message: 'categoryId is required' };

  const pk = categoryPK(categoryId);

  // Query all records for this category
  const items: Array<{ PK: string; SK: string }> = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: QUESTIONS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastKey,
    }));
    if (result.Items) items.push(...(result.Items as Array<{ PK: string; SK: string }>));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  if (items.length === 0) return { type: 'error', message: 'Category not found' };

  // Delete in batches of 25
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [QUESTIONS_TABLE]: batch.map(item => ({
          DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
        })),
      },
    }));
  }

  return { type: 'ack', action: 'delete', categoryId, deletedCount: items.length };
}

// ---------------------------------------------------------------------------
// expand — read existing questions, invoke ODF to generate more
// ---------------------------------------------------------------------------

/** Read existing questions for a category and invoke the Category Creator ODF to add 60 more. */
async function handleExpand(payload: CategoryPayload) {
  const { categoryId } = payload;
  if (!categoryId) return { type: 'error', message: 'categoryId is required' };

  const pk = categoryPK(categoryId);

  // Read category metadata
  const metaResult = await ddb.send(new QueryCommand({
    TableName: QUESTIONS_TABLE,
    KeyConditionExpression: 'PK = :pk AND SK = :sk',
    ExpressionAttributeValues: { ':pk': pk, ':sk': METADATA_SK },
  }));

  const metadata = metaResult.Items?.[0];
  if (!metadata) return { type: 'error', message: 'Category not found' };

  // Read all existing question texts to pass as context
  const questionItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: QUESTIONS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': QUESTION_PREFIX },
      ProjectionExpression: 'questionText, difficulty',
      ExclusiveStartKey: lastKey,
    }));
    if (result.Items) questionItems.push(...(result.Items as Record<string, unknown>[]));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  const existingQuestions = questionItems.map(q => ({
    questionText: q.questionText as string,
    difficulty: q.difficulty as string,
  }));

  // Invoke Category Creator ODF with expand mode
  await lambda.send(new InvokeCommand({
    FunctionName: CATEGORY_CREATOR_ARN,
    InvocationType: InvocationType.Event,
    Payload: JSON.stringify({
      categoryId,
      categoryName: metadata.categoryName as string,
      adminChannel: '/categories/default',
      expand: true,
      existingQuestions,
    }),
  }));

  return { type: 'ack', action: 'expand', categoryId, categoryName: metadata.categoryName as string, existingCount: existingQuestions.length };
}
