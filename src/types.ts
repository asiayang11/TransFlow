export type PageStatus =
  | "pending"
  | "queued"
  | "preparing"
  | "analyzing"
  | "translating"
  | "typesetting"
  | "generating"
  | "validating"
  | "ready"
  | "error";

export interface PageSummary {
  page_number: number;
  status: PageStatus;
  progress: number;
  stage: PageStatus;
  stage_label: string;
  stage_current: number;
  stage_total: number;
  queue_position: number | null;
  queue_total: number;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  metrics: {
    queue_wait_ms: number;
    total_ms: number;
    stage_durations_ms: Record<string, number>;
    llm_logical_requests: number;
    llm_cache_hits: number;
    llm_request_attempts: number;
    llm_rate_limit_errors: number;
    llm_error_count: number;
    llm_latency_ms_total: number;
    llm_latency_ms_max: number;
    prompt_tokens: number;
    completion_tokens: number;
    layout_model_reused: boolean;
    layout_model_load_ms: number;
    translator_reused: boolean;
    translator_create_ms: number;
    table_ocr_used: boolean;
    table_model_reused: boolean;
    table_model_load_ms: number;
  };
  preflight: {
    native_text: boolean;
    text_character_count: number;
  };
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
  scheduler: {
    workers: number;
    queue_depth: number;
  };
  engine_runtime: {
    layout_model_ready: boolean;
    layout_model_load_ms: number;
    table_model_ready: boolean;
    table_model_load_ms: number;
    translator_count: number;
  };
}

export interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
  };
}
