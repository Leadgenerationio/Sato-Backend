import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { streamCsv } from '../utils/stream-csv.js';
import { logger } from '../utils/logger.js';

// The Activity CSV streams page by page. If reading fails once the headers are sent, the download is cut short (never ended as a
// short file that looks whole) and the failure is logged, so it is not silent.

function appWith(chunks: () => AsyncGenerator<string>) {
  const app = express();
  app.get('/x.csv', async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    await streamCsv(res, chunks(), 'Test export');
  });
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe('streamCsv', () => {
  it('sends the BOM first, then every chunk in order, then ends the response', async () => {
    const app = appWith(async function* () { yield 'a,b\r\n'; yield '1,2\r\n'; yield '3,4\r\n'; });
    const res = await request(app).get('/x.csv').buffer(true).parse((r, cb) => { let s = ''; r.setEncoding('utf8'); r.on('data', (c) => (s += c)); r.on('end', () => cb(null, s)); });
    expect(res.status).toBe(200);
    expect(res.body).toBe('\uFEFFa,b\r\n1,2\r\n3,4\r\n');
  });

  it('a failure after the headers are sent is LOGGED and cuts the download short instead of ending it as if complete', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const app = appWith(async function* () { yield 'a,b\r\n'; throw new Error('database went away'); });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const outcome = await new Promise<'aborted' | 'completed'>((resolve) => {
      http.get({ port, path: '/x.csv' }, (res) => { res.on('data', () => undefined); res.on('end', () => resolve('completed')); res.on('aborted', () => resolve('aborted')); res.on('error', () => resolve('aborted')); }).on('error', () => resolve('aborted'));
    });
    server.close();
    expect(outcome).toBe('aborted'); // the client sees a broken download, not a clean short file
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![1])).toMatch(/Test export failed part-way/);
  });

  it('stops reading AND closes the source when the client has gone away (no read left hanging)', async () => {
    let produced = 0; let closed = false;
    const app = appWith(async function* () {
      try { for (let i = 0; i < 1000; i++) { produced++; yield 'x'.repeat(65536); await new Promise((r) => setTimeout(r, 1)); } } finally { closed = true; }
    });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      const req = http.get({ port, path: '/x.csv' }, (res) => { res.once('data', () => { req.destroy(); resolve(); }); });
      req.on('error', () => undefined);
    });
    // wait for the event itself (source closed), not a fixed sleep; 10s is only the failure bound
    const deadline = Date.now() + 10_000;
    while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    server.close();
    expect(produced).toBeLessThan(1000); // it did not keep generating the whole file for a reader that left
    expect(closed).toBe(true); // the source (the database paging) was closed, not left suspended
  });
});
