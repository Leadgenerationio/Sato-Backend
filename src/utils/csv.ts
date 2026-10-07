export function csvCell(v: string | number): string {
  let s = String(v ?? '');
  // Neutralise spreadsheet formula injection (a company named "=HYPERLINK(...)").
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
