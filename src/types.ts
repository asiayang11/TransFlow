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
  translated_pdf_ready: boolean;
  pages: PageSummary[];
}

export interface PageResult extends PageSummary {
  source_text: string;
  translated_pdf_url: string | null;
}

export interface HealthRecord {
  status: "ok";
  llm_mode: "openai" | "mock";
  llm_configured: boolean;
  model: string;
  engine: string;
  base_url_configured: boolean;
  prefetch_pages: number;
}

export interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
  };
}
