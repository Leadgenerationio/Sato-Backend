export function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const apiUrl = () => requiredEnv('STATO_API_URL');
