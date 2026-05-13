import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { sops } from '../db/schema/sops.js';
import {
  callAnthropic as callAnthropicViaClient,
  isAnthropicConfigured,
} from '../integrations/anthropic/anthropic-client.js';
import { logger } from '../utils/logger.js';

// #91 AI new-task button (Sam Loom). Takes a one-line prompt and asks
// Claude to draft a structured task spec the user can review + edit
// before saving. Falls back to a 503 when ANTHROPIC_API_KEY is unset
// so the FE can show "AI not configured" gracefully.
//
// Design notes:
//   - We talk to Anthropic Messages API via fetch (no SDK dep). Stable
//     HTTP contract, smaller package footprint.
//   - We pass the business's existing SOPs (titles + ids) so the model
//     can suggest a linkedSopId from real data instead of hallucinating.
//   - We ask for JSON ONLY and parse defensively. Bad shape → 502 so
//     the FE can offer "try again or fill manually".

export interface AiTaskSuggestion {
  title: string;
  description: string;
  category: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  timeBlockMinutes: number | null;
  linkedSopId: string | null;
  linkedSopTitle: string | null;  // surfaced for FE display without re-fetching SOPs
  subtasks: string[];
}

const ALLOWED_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const ALLOWED_TIME_BLOCKS = new Set([15, 30, 60, 120, 240, 480, null]);

export class AiNotConfiguredError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY not configured');
    this.name = 'AiNotConfiguredError';
  }
}

export class AiBadOutputError extends Error {
  constructor(public raw: string, public reason: string) {
    super(`AI returned unparseable output: ${reason}`);
    this.name = 'AiBadOutputError';
  }
}

interface SopHint {
  id: string;
  title: string;
}

async function fetchSopHints(businessId: string | null): Promise<SopHint[]> {
  if (!businessId) return [];
  try {
    const rows = await db
      .select({ id: sops.id, title: sops.title })
      .from(sops)
      .where(eq(sops.businessId, businessId))
      .limit(50);
    return rows.map((r) => ({ id: r.id, title: r.title }));
  } catch (err) {
    // SOP lookup is a hint, not a hard dep — degrade quietly.
    logger.warn({ err }, 'AI task: failed to fetch SOPs for hinting');
    return [];
  }
}

function buildSystemPrompt(sopHints: SopHint[]): string {
  const sopList = sopHints.length
    ? sopHints.map((s) => `- ${s.id} | ${s.title}`).join('\n')
    : '(no SOPs available)';
  return [
    'You generate structured task specs for an ops platform.',
    'Given a brief user sentence, output a JSON object — and ONLY a JSON object — that the platform can use to create a task.',
    '',
    'Available SOPs you may link (id | title). Use a SOP ID only if the task is clearly about that procedure; otherwise return null.',
    sopList,
    '',
    'Output shape (strict — do not add or remove fields):',
    '{',
    '  "title": string (5-100 chars, imperative, e.g. "Process weekly Xero export"),',
    '  "description": string (2-4 sentences, plain text),',
    '  "category": "Operations" | "Finance" | "Marketing" | "Onboarding" | "Compliance" | "Admin" | "Other",',
    '  "priority": "low" | "medium" | "high" | "urgent",',
    '  "timeBlockMinutes": 15 | 30 | 60 | 120 | 240 | 480 | null,',
    '  "linkedSopId": string (one of the IDs above) | null,',
    '  "subtasks": string[] (3-7 atomic, imperative items)',
    '}',
    '',
    'Return ONLY the JSON. No preamble, no markdown fence, no trailing prose.',
  ].join('\n');
}

// Cleanup post-Hari-merge: was an inline fetch wrapper here. Now uses the
// shared integrations/anthropic/anthropic-client.ts which adds prompt
// caching on the system block (~10% cost on cache hits) and structured
// usage logging.
async function callAnthropic(systemPrompt: string, userPrompt: string): Promise<string> {
  const { text } = await callAnthropicViaClient({
    system: systemPrompt,
    userMessage: userPrompt,
    // Tasks system prompt is short-ish but stable across all generate calls
    // in a session — caching pays off after the first generation.
    cacheSystem: true,
    maxTokens: 1024,
    // Lower temperature = more deterministic structured output.
    temperature: 0.3,
    // Override the shared client's default model (sonnet-4-6 — overkill
    // for short structured-JSON tasks). Haiku is 10x cheaper and plenty
    // capable for "draft a task from a sentence". Sticking with this so
    // the cleanup is purely structural — no behavior change for users.
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  });
  if (!text) throw new Error('Anthropic returned empty content');
  return text;
}

function parseAndValidate(raw: string, sopHints: SopHint[]): AiTaskSuggestion {
  // Tolerate the occasional markdown fence even though we asked for raw JSON.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    throw new AiBadOutputError(raw, 'not JSON');
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new AiBadOutputError(raw, 'top-level not an object');
  }

  const title = String(obj.title ?? '').trim().slice(0, 100);
  if (!title) throw new AiBadOutputError(raw, 'missing title');
  const description = String(obj.description ?? '').trim();
  const category = String(obj.category ?? 'Other').trim();
  const priorityRaw = String(obj.priority ?? 'medium').toLowerCase();
  const priority = (ALLOWED_PRIORITIES.has(priorityRaw) ? priorityRaw : 'medium') as AiTaskSuggestion['priority'];

  const tbRaw = obj.timeBlockMinutes;
  const timeBlockMinutes = (tbRaw === null || ALLOWED_TIME_BLOCKS.has(tbRaw as number)) ? (tbRaw as number | null) : null;

  // Validate the SOP id against what we offered — never trust the model
  // to invent an id that exists.
  const sopIdRaw = obj.linkedSopId === null ? null : String(obj.linkedSopId ?? '').trim();
  const matchedSop = sopIdRaw ? sopHints.find((s) => s.id === sopIdRaw) : undefined;
  const linkedSopId = matchedSop ? matchedSop.id : null;
  const linkedSopTitle = matchedSop ? matchedSop.title : null;

  const subtasksRaw = Array.isArray(obj.subtasks) ? obj.subtasks : [];
  const subtasks = subtasksRaw
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0)
    .slice(0, 12);

  return {
    title,
    description,
    category,
    priority,
    timeBlockMinutes,
    linkedSopId,
    linkedSopTitle,
    subtasks,
  };
}

export async function generateTaskSuggestion(
  prompt: string,
  businessId: string | null,
): Promise<AiTaskSuggestion> {
  if (!isAnthropicConfigured()) {
    throw new AiNotConfiguredError();
  }
  const sopHints = await fetchSopHints(businessId);
  const system = buildSystemPrompt(sopHints);
  const raw = await callAnthropic(system, prompt);
  return parseAndValidate(raw, sopHints);
}
