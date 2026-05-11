import { logger } from '../../utils/logger.js';

/**
 * Lightweight Anthropic Messages API client used for in-app AI features
 * (currently: SOP generation from a Loom transcript).
 *
 * Talks directly to https://api.anthropic.com/v1/messages via fetch — no
 * SDK dependency, keeps the bundle small. Prompt caching is wired on the
 * system block so repeated SOP-generation calls re-use the system prompt
 * cache and pay ~10% of the input-token cost on cache hits.
 *
 * Default model is Claude Sonnet 4.6 — fast enough for an in-page generate
 * step (~3-5s for a 5min Loom transcript) and strong on structured-output
 * adherence.
 */

const API_HOST = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const API_VERSION = '2023-06-01';

export function isAnthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicTextBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  temperature?: number;
}

interface AnthropicResponse {
  id: string;
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AnthropicCallInput {
  system: string;
  userMessage: string;
  /** Marks the system block as cacheable. Pays off once the same system
   *  string is reused within ~5 minutes. */
  cacheSystem?: boolean;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export async function callAnthropic(input: AnthropicCallInput): Promise<{ text: string; usage: AnthropicResponse['usage'] }> {
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const body: AnthropicRequest = {
    model: input.model ?? DEFAULT_MODEL,
    max_tokens: input.maxTokens ?? 2048,
    system: input.cacheSystem
      ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }]
      : input.system,
    messages: [{ role: 'user', content: input.userMessage }],
    temperature: input.temperature ?? 0.4,
  };

  const res = await fetch(`${API_HOST}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    logger.error({ status: res.status, body: errBody }, 'Anthropic API call failed');
    throw new Error(`Anthropic API failed: ${res.status}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  logger.info(
    {
      model: data.model,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      cacheRead: data.usage.cache_read_input_tokens ?? 0,
      cacheWrite: data.usage.cache_creation_input_tokens ?? 0,
    },
    'anthropic-messages',
  );
  return { text, usage: data.usage };
}
