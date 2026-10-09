import { readFile } from 'node:fs/promises';
export async function loadWebConfig() {
  const dotenv = await readFile(new URL('../../.env', import.meta.url), 'utf8').catch(() => '');
  for (const raw of dotenv.split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const price = value => value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  return { thinking: process.env.TRANSFLOW_WEB_THINKING || 'disabled', inputPrice: price(process.env.TRANSFLOW_WEB_INPUT_USD_PER_MILLION), outputPrice: price(process.env.TRANSFLOW_WEB_OUTPUT_USD_PER_MILLION), key: process.env.OPENAI_API_KEY || '', model: process.env.OPENAI_MODEL || 'gpt-4o-mini', base: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', mode: process.env.TRANSFLOW_LLM_MODE || 'openai' };
}
