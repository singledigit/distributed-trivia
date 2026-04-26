/**
 * Category Creator ODF (Durable Function)
 *
 * Multi-step AI-powered category creation with live progress updates:
 * 1. Research — gather key facts and subtopics for the category
 * 2. Generate — produce 60 trivia questions using the research
 * 3. Validate — fact-check questions and fix/remove bad ones
 * 4. Save — write category + questions to QuestionsTable
 */

import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { generateUlid, publishToChannel } from './shared/index';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

const QUESTIONS_TABLE = process.env.QUESTIONS_TABLE_NAME!;
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-20250514-v1:0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategoryCreatorEvent {
  categoryName: string;
  adminChannel: string;
  // Expand mode — add questions to existing category
  expand?: boolean;
  categoryId?: string;
  existingQuestions?: Array<{ questionText: string; difficulty: string }>;
}

interface Question {
  questionText: string;
  options: string[];
  correctAnswer: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

const POINTS: Record<string, number> = { easy: 10, medium: 20, hard: 30 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callBedrock(system: string, prompt: string, maxTokens: number = 16000): Promise<string> {
  const response = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    system: [{ text: system }],
    inferenceConfig: { maxTokens, temperature: 0.7 },
  }));
  return response.output?.message?.content?.[0]?.text ?? '';
}

function extractJson<T>(text: string): T {
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  return JSON.parse(jsonStr) as T;
}

async function publishProgress(channel: string, categoryId: string, categoryName: string, step: string, message: string) {
  await publishToChannel({
    channel,
    events: [{
      type: 'category_progress',
      categoryId,
      categoryName,
      step,
      message,
    }],
  });
}

function validateQuestions(raw: Question[]): Question[] {
  const valid: Question[] = [];
  for (const q of raw) {
    if (!q.questionText || !q.correctAnswer) continue;
    if (!Array.isArray(q.options) || (q.options.length !== 2 && q.options.length !== 4)) continue;
    if (!['easy', 'medium', 'hard'].includes(q.difficulty)) continue;
    if (!q.options.includes(q.correctAnswer)) continue;
    valid.push(q);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = withDurableExecution(
  async (event: CategoryCreatorEvent, context: DurableContext): Promise<unknown> => {
    const { categoryName, adminChannel, expand, existingQuestions } = event;
    const isExpand = expand === true;

    // Use provided categoryId for expand, generate new one for create
    const categoryId = isExpand && event.categoryId
      ? event.categoryId
      : await context.step('generate-category-id', async () => generateUlid());

    context.logger.info('Category Creator started', { categoryName, categoryId, isExpand, existingCount: existingQuestions?.length ?? 0 });

    // ---- Step 1: Research ----
    await context.step('progress-research', async () => {
      await publishProgress(adminChannel, categoryId, categoryName, 'research', `Researching "${categoryName}" topics…`);
    });

    const research = await context.step('research', async () => {
      const result = await callBedrock(
        'You are a research assistant specializing in creating comprehensive topic outlines for trivia games.',
        `Research the topic "${categoryName}" and produce a detailed outline for trivia question creation.

Include:
- 8-12 major subtopics or themes within this category
- For each subtopic, list 3-5 specific facts, events, people, or details that would make good trivia questions
- Note which facts are common knowledge (easy), require some familiarity (medium), or are obscure (hard)
- Include a mix of factual, historical, cultural, and technical aspects where applicable

Return a structured outline as plain text.`,
        4000,
      );
      return result;
    });

    context.logger.info('Research complete', { length: research.length });

    // ---- Step 1b: Pick category emoji and theme color (skip for expand) ----
    let categoryEmoji = '';
    let categoryColor = '';

    if (!isExpand) {
      const categoryTheme = await context.step('pick-theme', async () => {
        const result = await callBedrock(
          'You select a single emoji and a vibrant hex color that best represent a trivia category. Return ONLY valid JSON with two fields: emoji and color. The color should be a bright, saturated hex color that works well on a dark background.',
          `Pick one emoji and one hex color for the trivia category "${categoryName}". Return JSON like: {"emoji":"🚀","color":"#06b6d4"}`,
          100,
        );
        try {
          let jsonStr = result.trim();
          const match = jsonStr.match(/\{[\s\S]*\}/);
          if (match) jsonStr = match[0];
          const parsed = JSON.parse(jsonStr) as { emoji?: string; color?: string };
          const emoji = parsed.emoji && parsed.emoji.length <= 4 ? parsed.emoji : '🧠';
          const color = parsed.color && /^#[0-9a-fA-F]{6}$/.test(parsed.color) ? parsed.color : '#f59e0b';
          return { emoji, color };
        } catch {
          return { emoji: '🧠', color: '#f59e0b' };
        }
      });

      categoryEmoji = categoryTheme.emoji;
      categoryColor = categoryTheme.color;
      context.logger.info('Theme selected', { categoryEmoji, categoryColor });
    }

    // ---- Step 2: Generate questions ----
    const existingContext = isExpand && existingQuestions && existingQuestions.length > 0
      ? `\n\nEXISTING QUESTIONS (do NOT duplicate any of these):\n${existingQuestions.map((q, i) => `${i + 1}. [${q.difficulty}] ${q.questionText}`).join('\n')}\n`
      : '';

    await context.step('progress-generate', async () => {
      await publishProgress(adminChannel, categoryId, categoryName, 'generate',
        isExpand ? `Generating 60 new questions (avoiding ${existingQuestions?.length ?? 0} existing)…` : 'Generating 60 trivia questions…');
    });

    const rawQuestions = await context.step('generate-questions', async () => {
      const result = await callBedrock(
        'You are an expert trivia question writer. You create high-quality, accurate, engaging trivia questions. Use the provided research to ensure factual accuracy and broad topic coverage.',
        `Using this research on "${categoryName}":

${research}
${existingContext}
Generate exactly 60 NEW trivia questions. Requirements:
- Exactly 20 easy, 20 medium, 20 hard questions
- Each question: 4 answer options OR True/False with ["True", "False"]
- correctAnswer must exactly match one option
- Easy = common knowledge, Medium = requires familiarity, Hard = challenges experts
- Cover the full breadth of subtopics from the research
- Mix in 2-4 True/False questions across difficulty levels
- All facts must be accurate and verifiable${isExpand ? '\n- Do NOT repeat or rephrase any of the existing questions listed above\n- Cover different aspects and facts than the existing questions' : ''}

Return ONLY a JSON array. Each element:
{"questionText":"...","options":["A","B","C","D"],"correctAnswer":"B","difficulty":"easy"}`,
      );
      return extractJson<Question[]>(result);
    });

    const structurallyValid = validateQuestions(rawQuestions);
    context.logger.info('Questions generated', { raw: rawQuestions.length, valid: structurallyValid.length });

    // ---- Step 3: Validate answers ----
    await context.step('progress-validate', async () => {
      await publishProgress(adminChannel, categoryId, categoryName, 'validate', `Validating ${structurallyValid.length} questions…`);
    });

    const validatedQuestions = await context.step('validate-questions', async () => {
      const result = await callBedrock(
        'You are a fact-checker and trivia editor. Your job is to verify trivia questions for accuracy and fix any errors.',
        `Review these ${structurallyValid.length} trivia questions about "${categoryName}".

For each question:
1. Verify the correctAnswer is factually accurate
2. Verify no other option could also be considered correct
3. Fix any incorrect answers by changing correctAnswer to the right option
4. Remove questions that are ambiguous or have multiple valid answers

Return ONLY a JSON array of the verified/fixed questions (same format as input). Remove any questions you cannot verify.

${JSON.stringify(structurallyValid)}`,
      );
      return validateQuestions(extractJson<Question[]>(result));
    });

    context.logger.info('Validation complete', { before: structurallyValid.length, after: validatedQuestions.length });

    if (validatedQuestions.length < 20) {
      await context.step('publish-error', async () => {
        await publishToChannel({
          channel: adminChannel,
          events: [{
            type: 'category_error',
            categoryId,
            categoryName,
            message: `Only ${validatedQuestions.length} questions passed validation — need at least 20`,
          }],
        });
      });
      return { status: 'failed', categoryId, reason: 'insufficient valid questions' };
    }

    // ---- Step 4: Save to DynamoDB ----
    await context.step('progress-save', async () => {
      await publishProgress(adminChannel, categoryId, categoryName, 'save', `Saving ${validatedQuestions.length} questions…`);
    });

    const items: Record<string, unknown>[] = isExpand
      ? [] // No METADATA for expand — category already exists
      : [{ PK: `CATEGORY#${categoryId}`, SK: 'METADATA', categoryId, categoryName, categoryEmoji, categoryColor }];

    for (const q of validatedQuestions) {
      const questionId = generateUlid();
      items.push({
        PK: `CATEGORY#${categoryId}`,
        SK: `QUESTION#${questionId}`,
        questionId,
        questionText: q.questionText,
        options: q.options,
        correctAnswer: q.correctAnswer,
        difficulty: q.difficulty,
        points: POINTS[q.difficulty] ?? 10,
      });
    }

    const batches: Record<string, unknown>[][] = [];
    for (let i = 0; i < items.length; i += 25) {
      batches.push(items.slice(i, i + 25));
    }

    for (let i = 0; i < batches.length; i++) {
      await context.step(`write-batch-${i}`, async () => {
        let requestItems: Record<string, unknown> = {
          [QUESTIONS_TABLE]: batches[i].map(item => ({ PutRequest: { Item: item } })),
        };
        let retries = 0;
        while (retries < 3) {
          const result = await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
          const unprocessed = result.UnprocessedItems;
          if (!unprocessed || Object.keys(unprocessed).length === 0) break;
          requestItems = unprocessed;
          retries++;
          await new Promise(r => setTimeout(r, 1000 * retries));
        }
      });
    }

    // ---- Done ----
    const easy = validatedQuestions.filter(q => q.difficulty === 'easy').length;
    const medium = validatedQuestions.filter(q => q.difficulty === 'medium').length;
    const hard = validatedQuestions.filter(q => q.difficulty === 'hard').length;

    await context.step('publish-complete', async () => {
      await publishToChannel({
        channel: adminChannel,
        events: [{
          type: isExpand ? 'category_expanded' : 'category_created',
          categoryId,
          categoryName,
          categoryEmoji,
          questionCount: validatedQuestions.length,
          easy,
          medium,
          hard,
        }],
      });
    });

    context.logger.info('Category Creator completed', { categoryId, categoryName, questionCount: validatedQuestions.length });
    return { status: 'completed', categoryId, categoryName, questionCount: validatedQuestions.length };
  },
);
