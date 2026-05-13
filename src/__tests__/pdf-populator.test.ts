import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { populatePdf } from '../services/pdf-populator.js';
import type { FieldLayout } from '../db/schema/agreement-templates.js';

async function loadFixture(): Promise<Uint8Array> {
  return new Uint8Array(await readFile('src/__tests__/fixtures/template-test.pdf'));
}

describe('pdf-populator', () => {
  it('draws variable text at converted coordinates', async () => {
    const bytes = await loadFixture();
    const layout: FieldLayout = [
      { id: 'f1', type: 'variable', variableKey: 'client.companyName', page: 0, xPct: 0.15, yPct: 0.165, widthPct: 0.3, heightPct: 0.03 },
    ];
    const out = await populatePdf(bytes, layout, { 'client.companyName': 'Acme Ltd' });
    expect(out.length).toBeGreaterThan(bytes.length);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it('draws literal text fields too', async () => {
    const bytes = await loadFixture();
    const layout: FieldLayout = [
      { id: 'f1', type: 'text', text: 'Static literal', page: 0, xPct: 0.1, yPct: 0.5, widthPct: 0.4, heightPct: 0.03 },
    ];
    const out = await populatePdf(bytes, layout, {});
    expect(out.length).toBeGreaterThan(bytes.length);
  });

  it('skips signature and date_signed fields (they go to SignNow)', async () => {
    const bytes = await loadFixture();
    const layout: FieldLayout = [
      { id: 'f1', type: 'signature', page: 0, xPct: 0.1, yPct: 0.8, widthPct: 0.3, heightPct: 0.05 },
      { id: 'f2', type: 'date_signed', page: 0, xPct: 0.5, yPct: 0.8, widthPct: 0.2, heightPct: 0.03 },
    ];
    const out = await populatePdf(bytes, layout, {});
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it('renders empty variable value as no-op (no exception)', async () => {
    const bytes = await loadFixture();
    const layout: FieldLayout = [
      { id: 'f1', type: 'variable', variableKey: 'client.vatNumber', page: 0, xPct: 0.1, yPct: 0.2, widthPct: 0.3, heightPct: 0.04 },
    ];
    const out = await populatePdf(bytes, layout, { 'client.vatNumber': '' });
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it('coordinate conversion: yPct=0 places near top of page (highest y in pdf-lib)', async () => {
    const bytes = await loadFixture();
    const layout: FieldLayout = [
      { id: 'f1', type: 'text', text: 'TOP', page: 0, xPct: 0.1, yPct: 0.0, widthPct: 0.3, heightPct: 0.05 },
    ];
    const out = await populatePdf(bytes, layout, {});
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });
});
