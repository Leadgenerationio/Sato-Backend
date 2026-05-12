import { Request, Response } from 'express';
import * as aiService from '../services/ai-task.service.js';
import { logger } from '../utils/logger.js';

export async function generateTask(req: Request, res: Response) {
  const { prompt } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ status: 'error', message: 'prompt is required' });
    return;
  }
  try {
    const suggestion = await aiService.generateTaskSuggestion(prompt.trim(), req.user!.businessId ?? null);
    res.json({ status: 'success', data: { suggestion } });
  } catch (err) {
    if (err instanceof aiService.AiNotConfiguredError) {
      res.status(503).json({ status: 'error', message: 'AI suggestions are not configured for this environment' });
      return;
    }
    if (err instanceof aiService.AiBadOutputError) {
      logger.warn({ raw: err.raw, reason: err.reason }, 'AI returned unparseable output');
      res.status(502).json({ status: 'error', message: 'The AI returned a malformed response. Try rephrasing your prompt.' });
      return;
    }
    logger.error({ err }, 'AI generate-task failed');
    res.status(500).json({ status: 'error', message: 'Failed to generate suggestion' });
  }
}
