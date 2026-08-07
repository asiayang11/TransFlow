export type PageStatus = "pending" | "queued" | "translating" | "ready" | "error";

export interface PageSummary {
  page_number: number;
  status: PageStatus;
  error: string | null;
  updated_at: string | null;
}

export interface DocumentRecord {
  id: string;
  filename: string;
  size_bytes: number;
  page_count: number;
  target_language: string;
  status: "active" | "error";
  created_at: string;
  prefetch_pages: number;
  pages: PageSummary[];
}

export interface PageResult extends PageSummary {
  source_text: string;
  translated_text: string | null;
  usage: Record<string, number> | null;
}

export interface HealthRecord {
  status: "ok";
  llm_mode: "openai" | "mock";
  llm_configured: boolean;
  model: string;
  prefetch_pages: number;
}

export interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
  };
}

