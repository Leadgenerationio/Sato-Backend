import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { FieldLayout } from '../db/schema/agreement-templates.js';

/**
 * Bake a template PDF with resolved variable values + literal text fields.
 * signature + date_signed fields are skipped — they get passed verbatim to
 * SignNow by the agreement-send flow.
 *
 * Coordinates: editor stores top-left percentage (0..1); pdf-lib uses
 * bottom-left absolute pt. Conversion: absY = (1 - yPct - heightPct) * pageH.
 */
export async function populatePdf(
  templatePdfBytes: Uint8Array,
  fieldLayout: FieldLayout,
  resolved: Record<string, string>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(templatePdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const f of fieldLayout) {
    if (f.type !== 'variable' && f.type !== 'text') continue;
    if (f.page < 0 || f.page >= pdf.getPageCount()) continue;
    const page = pdf.getPage(f.page);
    const { width: pageW, height: pageH } = page.getSize();

    const value = f.type === 'text' ? (f.text ?? '') : (resolved[f.variableKey ?? ''] ?? '');
    if (!value) continue;

    const absX = f.xPct * pageW;
    const absY = (1 - f.yPct - f.heightPct) * pageH;

    page.drawText(value, {
      x: absX,
      y: absY,
      size: f.fontSize ?? 11,
      font,
      color: rgb(0, 0, 0),
    });
  }

  return pdf.save();
}
