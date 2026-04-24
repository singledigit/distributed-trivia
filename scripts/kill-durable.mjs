/**
 * Kill all running durable executions for ODF and POD functions.
 * Usage: node scripts/kill-durable.mjs
 */
import {
  LambdaClient,
  ListDurableExecutionsByFunctionCommand,
  StopDurableExecutionCommand,
  GetAliasCommand,
} from '@aws-sdk/client-lambda';
import { fromIni } from '@aws-sdk/credential-providers';

const lambda = new LambdaClient({
  region: 'us-west-2',
  credentials: fromIni({ profile: 'demo' }),
});

const FUNCTIONS = [
  'trivia-session-odf',
  'trivia-participant-pod',
];

async function listAndKill(functionName) {
  console.log(`\n🔍 Checking ${functionName}...`);

  // List all versions and check each
  try {
    let nextToken;
    let total = 0;

    let version;
    try {
      const alias = await lambda.send(new GetAliasCommand({
        FunctionName: functionName,
        Name: 'live',
      }));
      version = alias.FunctionVersion;
    } catch {
      version = '$LATEST';
    }

    console.log(`  Using version: ${version}`);

    do {
      const result = await lambda.send(new ListDurableExecutionsByFunctionCommand({
        FunctionName: functionName,
        Qualifier: version,
        Status: 'RUNNING',
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));

      const executions = result.DurableExecutions || [];
      nextToken = result.NextToken;

      for (const exec of executions) {
        total++;
        console.log(`  🛑 Stopping: ${exec.DurableExecutionArn}`);
        try {
          await lambda.send(new StopDurableExecutionCommand({
            DurableExecutionArn: exec.DurableExecutionArn,
            Error: {
              ErrorType: 'DevCleanup',
              ErrorMessage: 'Stopped by kill-durable script',
            },
          }));
          console.log(`     ✅ Stopped`);
        } catch (err) {
          console.error(`     ❌ Failed to stop: ${err.message}`);
        }
      }
    } while (nextToken);

    if (total === 0) {
      console.log('  No running executions found.');
    } else {
      console.log(`  Stopped ${total} execution(s).`);
    }
  } catch (err) {
    console.error(`  ❌ Error listing executions: ${err.message}`);
  }
}

async function main() {
  console.log('Killing all running durable executions...');
  for (const fn of FUNCTIONS) {
    await listAndKill(fn);
  }
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
