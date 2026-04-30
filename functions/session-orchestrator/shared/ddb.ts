import { DynamoDBDocumentClient, QueryCommand, QueryCommandInput } from '@aws-sdk/lib-dynamodb';

/**
 * Execute a paginated DynamoDB Query, returning all items.
 * Handles LastEvaluatedKey automatically.
 */
export async function paginatedQuery<T = Record<string, unknown>>(
  ddb: DynamoDBDocumentClient,
  params: Omit<QueryCommandInput, 'ExclusiveStartKey'>,
): Promise<T[]> {
  const items: T[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new QueryCommand({
      ...params,
      ExclusiveStartKey: lastKey,
    }));
    if (result.Items) items.push(...(result.Items as T[]));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return items;
}
