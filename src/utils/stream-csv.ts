import type { Response } from 'express';
import { logger } from './logger.js';

/** Wait until the socket takes more, or the client has gone (then res.destroyed stops the loop). */
function drainOrClose(res: Response) {
  return new Promise<void>((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Stream CSV text to the client a chunk at a time (the caller has set the headers). The BOM goes first so Excel reads accents.
 * If the client leaves, stop reading. If reading fails once the headers are gone, cut the download short and LOG it:
 * ending a short file as if it were whole would be silent data loss, and without the log nobody would know it happened.
 */
export async function streamCsv(res: Response, chunks: AsyncIterable<string>, what = 'CSV export'): Promise<void> {
  res.write('\uFEFF');
  try {
    for await (const chunk of chunks) {
      if (res.destroyed) return;
      if (!res.write(chunk)) {
        await drainOrClose(res);
        if (res.destroyed) return; // the client left while we waited: do not pull another chunk (another database page)
      }
    }
    res.end();
  } catch (err) {
    logger.error({ err }, `${what} failed part-way: the download was cut short`);
    res.destroy(err as Error);
  }
}
