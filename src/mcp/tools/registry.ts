import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StatoTool } from '../types.js';

const TOOL_FILE = /\.tool\.(ts|js|mjs)$/;

export function defaultToolsDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Load every <name>.tool.(ts|js) in the folder. A file exports its tool as
 *  `default` (or `tool`). Duplicate names fail loudly at start-up. */
export async function loadTools(dir: string = defaultToolsDir()): Promise<StatoTool[]> {
  const files = fs.readdirSync(dir).filter((f) => TOOL_FILE.test(f) && !f.endsWith('.d.ts')).sort();
  const tools: StatoTool[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as { default?: StatoTool; tool?: StatoTool };
    const t = mod.default ?? mod.tool;
    if (!t || typeof t.name !== 'string' || typeof t.handler !== 'function') {
      throw new Error(`MCP tool file ${f} must export a tool (default export with name and handler)`);
    }
    if (tools.some((x) => x.name === t.name)) throw new Error(`Duplicate MCP tool name "${t.name}" (file ${f})`);
    tools.push(t);
  }
  return tools;
}

let cache: Promise<StatoTool[]> | null = null;
/** Loaded once per process. */
export function getTools(): Promise<StatoTool[]> {
  return (cache ??= loadTools());
}
