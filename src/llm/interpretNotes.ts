import Anthropic from "@anthropic-ai/sdk";
import { config, activeApiKeyPresent } from "../config";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

export interface LlmResult {
  /** Raw, untrusted objects straight from the model. Guardrails validate them next. */
  raw: unknown[];
  /** "llm" when the model answered, "fallback" when the deterministic net was used. */
  source: "llm" | "fallback";
  model: string;
  latencyMs: number;
  error?: string;
}

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.anthropicApiKey,
      ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
      maxRetries: 0, // retries handled here so we control total latency
    });
  }
  return anthropicClient;
}

/* --------------------------- tiny in-memory cache -------------------------- */

const cache = new Map<string, unknown>();

function cacheKey(notes: string[], capacity: number): string {
  return `${capacity}|${notes.join("\u0001")}`;
}

function cacheGet(key: string): unknown | undefined {
  if (!config.llmCacheEnabled) return undefined;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit); // refresh LRU position
  }
  return hit;
}

function cacheSet(key: string, value: unknown): void {
  if (!config.llmCacheEnabled) return;
  cache.set(key, value);
  while (cache.size > config.llmCacheSize) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/* ------------------------------ JSON recovery ------------------------------ */

/** Pull a JSON array out of a model response that may contain stray text. */
export function extractJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["directive_interpretation", "directives", "results", "items"]) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[];
      }
      return [parsed];
    }
  } catch {
    /* fall through to bracket scan */
  }

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }

  throw new Error("model response did not contain a parsable JSON array");
}

/* ------------------------------- providers -------------------------------- */

async function callAnthropic(notes: string[], capacity: number): Promise<string> {
  const response = await getAnthropic().messages.create(
    {
      model: config.llmModel,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(notes, capacity) }],
    },
    { timeout: config.llmTimeoutMs },
  );

  return response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

async function callOpenAI(notes: string[], capacity: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0,
        max_tokens: 1500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(notes, capacity) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`openai responded with status ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------- entry ---------------------------------- */

/**
 * Mandatory LLM step: operator notes -> untrusted structured directives.
 * Throws only for caller-visible configuration problems; transport/parse errors
 * are surfaced through the returned `error` field so the route can degrade safely.
 */
export async function interpretNotesWithLlm(
  notes: string[],
  batteryCapacityKwh: number,
): Promise<LlmResult> {
  const started = Date.now();
  const model = config.llmModel;

  if (!activeApiKeyPresent()) {
    return {
      raw: [],
      source: "fallback",
      model,
      latencyMs: 0,
      error: `no api key configured for provider "${config.llmProvider}"`,
    };
  }

  const key = cacheKey(notes, batteryCapacityKwh);
  const cached = cacheGet(key);
  if (cached !== undefined) {
    return {
      raw: cached as unknown[],
      source: "llm",
      model,
      latencyMs: Date.now() - started,
    };
  }

  let lastError = "";
  for (let attempt = 0; attempt <= config.llmMaxRetries; attempt++) {
    try {
      const text =
        config.llmProvider === "openai"
          ? await callOpenAI(notes, batteryCapacityKwh)
          : await callAnthropic(notes, batteryCapacityKwh);

      const raw = extractJsonArray(text);
      cacheSet(key, raw);
      return { raw, source: "llm", model, latencyMs: Date.now() - started };
    } catch (err) {
      // Never log the key or the full provider payload.
      lastError = err instanceof Error ? err.message : "unknown model error";
    }
  }

  return {
    raw: [],
    source: "fallback",
    model,
    latencyMs: Date.now() - started,
    error: lastError,
  };
}
