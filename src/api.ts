import type { ApiErrorShape, DocumentRecord, HealthRecord, PageResult } from "./types";

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  let message = `请求失败（${response.status}）`;
  try {
    const payload = (await response.json()) as ApiErrorShape;
    message = payload.error?.message || message;
  } catch {
    // The fallback includes the HTTP status and is safe to show.
  }
  throw new Error(message);
}

export async function getHealth(): Promise<HealthRecord> {
  return parseResponse<HealthRecord>(await fetch("/api/v1/health"));
}

export async function uploadDocument(file: File, targetLanguage: string): Promise<DocumentRecord> {
  const response = await fetch("/api/v1/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Filename": encodeURIComponent(file.name),
      "X-Target-Language": targetLanguage,
    },
    body: file,
  });
  return parseResponse<DocumentRecord>(response);
}

export async function getDocument(documentId: string): Promise<DocumentRecord> {
  return parseResponse<DocumentRecord>(await fetch(`/api/v1/documents/${documentId}`));
}

export async function getPage(documentId: string, page: number): Promise<PageResult> {
  return parseResponse<PageResult>(
    await fetch(`/api/v1/documents/${documentId}/pages/${page}`),
  );
}

export async function translatePage(documentId: string, page: number): Promise<void> {
  await parseResponse(
    await fetch(`/api/v1/documents/${documentId}/pages/${page}/translate`, {
      method: "POST",
    }),
  );
}

export async function prefetchPages(
  documentId: string,
  startPage: number,
  count = 5,
): Promise<void> {
  await parseResponse(
    await fetch(`/api/v1/documents/${documentId}/prefetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_page: startPage, count }),
    }),
  );
}

