import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export class WebTranslationError extends Error {
  constructor(code, message, { format = false, httpStatus } = {}) {
    super(message);
    this.code = code;
    this.format = format;
    this.httpStatus = httpStatus;
  }
}

export function translationDiagnostic(error, timedOut = false) {
  if (timedOut) return { code: 'MODEL_TIMEOUT', message: '翻译请求超时，未收到可用译文。' };
  if (error instanceof WebTranslationError) {
    const { code, message, httpStatus } = error;
    return { code, message, ...(httpStatus ? { httpStatus } : {}) };
  }
  return { code: 'TRANSLATION_INTERNAL', message: '翻译服务处理失败，请稍后重试。' };
}

export function createFailureLogger(directory) {
  const path = join(directory, 'translation-errors.jsonl');
  let queue = Promise.resolve();
  return {
    write({ sessionId, epoch, blockId, language, code, message, httpStatus }) {
      const sessionRef = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
      const line = JSON.stringify({ time: new Date().toISOString(), event: 'web_translation_failed',
        sessionRef, epoch, blockId, language, code, message, httpStatus });
      queue = queue.then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await appendFile(path, line + '\n', { mode: 0o600 });
      }).catch(() => console.error(line));
    },
    flush: () => queue,
  };
}
