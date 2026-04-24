/**
 * Seed script for QuestionsTable.
 *
 * Reads JSON files from the questions/ directory (one file per category)
 * and writes them to DynamoDB.
 *
 * Expected JSON format per file:
 * {
 *   "categoryName": "Science & Nature",
 *   "questions": [
 *     {
 *       "questionText": "...",
 *       "options": ["A", "B", "C", "D"],
 *       "correctAnswer": "B",
 *       "difficulty": "easy" | "medium" | "hard"
 *     }
 *   ]
 * }
 *
 * Usage:
 *   npx tsx scripts/seed.ts [tableName]
 *
 * Defaults to "trivia-questions" if no table name is provided.
 * Uses AWS profile "demo" and region "us-west-2".
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";

// ---------------------------------------------------------------------------
// ULID generator (mirrors shared/ulid.ts)
// ---------------------------------------------------------------------------

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, length: number): string {
  let str = "";
  let remaining = now;
  for (let i = length; i > 0; i--) {
    const mod = remaining % 32;
    str = CROCKFORD_BASE32[mod] + str;
    remaining = (remaining - mod) / 32;
  }
  return str;
}

function encodeRandom(length: number): string {
  let str = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    str += CROCKFORD_BASE32[bytes[i] % 32];
  }
  return str;
}

function generateUlid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Difficulty = "easy" | "medium" | "hard";

interface SeedQuestion {
  questionText: string;
  options: string[];
  correctAnswer: string;
  difficulty: Difficulty;
}

interface CategoryFile {
  categoryName: string;
  questions: SeedQuestion[];
}

interface Category extends CategoryFile {
  categoryId: string;
}

// ---------------------------------------------------------------------------
// Points mapping
// ---------------------------------------------------------------------------

const POINTS: Record<Difficulty, number> = {
  easy: 10,
  medium: 20,
  hard: 30,
};

// ---------------------------------------------------------------------------
// Load categories from questions/ directory
// ---------------------------------------------------------------------------

async function loadCategories(): Promise<Category[]> {
  const scriptDir = new URL(".", import.meta.url).pathname;
  const questionsDir = resolve(scriptDir, "../questions");
  const files = await readdir(questionsDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

  if (jsonFiles.length === 0) {
    throw new Error(`No JSON files found in ${questionsDir}`);
  }

  const categories: Category[] = [];

  for (const file of jsonFiles) {
    const filePath = join(questionsDir, file);
    const raw = await readFile(filePath, "utf-8");
    let data: CategoryFile;

    try {
      data = JSON.parse(raw) as CategoryFile;
    } catch {
      console.error(`  ⚠ Skipping ${file}: invalid JSON`);
      continue;
    }

    // Validate
    if (!data.categoryName || !Array.isArray(data.questions)) {
      console.error(`  ⚠ Skipping ${file}: missing categoryName or questions array`);
      continue;
    }

    // Validate each question
    const validQuestions: SeedQuestion[] = [];
    for (let i = 0; i < data.questions.length; i++) {
      const q = data.questions[i];
      const errors: string[] = [];

      if (!q.questionText) errors.push("missing questionText");
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push("options must have at least 2 entries");
      if (!q.correctAnswer) errors.push("missing correctAnswer");
      if (!["easy", "medium", "hard"].includes(q.difficulty)) errors.push(`invalid difficulty: ${q.difficulty}`);
      if (q.options && !q.options.includes(q.correctAnswer)) errors.push(`correctAnswer "${q.correctAnswer}" not in options`);

      if (errors.length > 0) {
        console.error(`  ⚠ ${file} question ${i + 1}: ${errors.join(", ")}`);
      } else {
        validQuestions.push(q);
      }
    }

    if (validQuestions.length === 0) {
      console.error(`  ⚠ Skipping ${file}: no valid questions`);
      continue;
    }

    categories.push({
      categoryId: generateUlid(),
      categoryName: data.categoryName,
      questions: validQuestions,
    });

    console.log(`  ✓ ${file}: "${data.categoryName}" — ${validQuestions.length} questions`);
  }

  return categories;
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

function buildItems(categories: Category[]) {
  const items: Record<string, unknown>[] = [];

  for (const cat of categories) {
    // Category METADATA record
    items.push({
      PK: `CATEGORY#${cat.categoryId}`,
      SK: "METADATA",
      categoryId: cat.categoryId,
      categoryName: cat.categoryName,
    });

    // Question records
    for (const q of cat.questions) {
      const questionId = generateUlid();
      items.push({
        PK: `CATEGORY#${cat.categoryId}`,
        SK: `QUESTION#${questionId}`,
        questionId,
        questionText: q.questionText,
        options: q.options,
        correctAnswer: q.correctAnswer,
        difficulty: q.difficulty,
        points: POINTS[q.difficulty],
      });
    }
  }

  return items;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function seed(tableName: string) {
  console.log(`\nLoading categories from questions/ ...\n`);
  const categories = await loadCategories();

  if (categories.length === 0) {
    console.error("\nNo categories loaded. Nothing to seed.");
    process.exit(1);
  }

  const client = new DynamoDBClient({
    region: "us-west-2",
    credentials: fromIni({ profile: "demo" }),
  });
  const ddb = DynamoDBDocumentClient.from(client);

  const items = buildItems(categories);
  const batches = chunk(items, 25);

  console.log(`\nSeeding ${items.length} items into "${tableName}" in ${batches.length} batches...\n`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const requestItems = {
      [tableName]: batch.map((item) => ({
        PutRequest: { Item: item },
      })),
    };

    const result = await ddb.send(
      new BatchWriteCommand({ RequestItems: requestItems })
    );

    // Handle unprocessed items with simple retry
    let unprocessed = result.UnprocessedItems;
    let retries = 0;
    while (unprocessed && Object.keys(unprocessed).length > 0 && retries < 3) {
      retries++;
      const unprocessedCount = unprocessed[tableName]?.length ?? 0;
      console.log(`  Batch ${i + 1}: retrying ${unprocessedCount} unprocessed items (attempt ${retries})...`);
      await new Promise((r) => setTimeout(r, 1000 * retries));
      const retry = await ddb.send(
        new BatchWriteCommand({ RequestItems: unprocessed })
      );
      unprocessed = retry.UnprocessedItems;
    }

    console.log(`  Batch ${i + 1}/${batches.length} written (${batch.length} items)`);
  }

  // Print summary
  console.log("\n✅ Seed complete!\n");
  for (const cat of categories) {
    const easy = cat.questions.filter((q) => q.difficulty === "easy").length;
    const medium = cat.questions.filter((q) => q.difficulty === "medium").length;
    const hard = cat.questions.filter((q) => q.difficulty === "hard").length;
    const tf = cat.questions.filter((q) => q.options.length === 2).length;
    console.log(
      `  ${cat.categoryName} (${cat.categoryId}): ${cat.questions.length} questions (${easy}E/${medium}M/${hard}H, ${tf} T/F)`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const tableName =
  process.env.QUESTIONS_TABLE_NAME ?? process.argv[2] ?? "trivia-questions";

seed(tableName).catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
