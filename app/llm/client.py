"""LLM client: strict JSON-schema call over a multi-provider model chain.

Supports the qualified-project env names (GROQ_*, CEREBRAS_*) AND the legacy
gridwise-api names (OPENAI_* pointing at Groq, GEMINI_*, OLLAMA_*) so the
existing Render deployment keeps working without dashboard changes.

Chain order: GROQ primary -> CEREBRAS (high RPM backstop) -> OPENAI-compatible
-> GEMINI -> GROQ fallbacks -> OLLAMA. Providers without a key are skipped.
LLM_CHAIN="provider:model,..." overrides the order explicitly.

Golden rule (CleanPass): LLM does language only — it returns directive_type,
windows [[start,end)], value+unit per note. Code (guardrails) does arithmetic.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request
from collections import OrderedDict

from app.guardrails import check_item
from app.llm.prompt import RESPONSE_SCHEMA, SYSTEM_PROMPT, user_message

log = logging.getLogger("gridwise.llm")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# Legacy gridwise-api used milliseconds; qualified project uses seconds.
if os.getenv("LLM_TIMEOUT_S"):
    PER_CALL_TIMEOUT_S = _env_float("LLM_TIMEOUT_S", 8.0)
else:
    PER_CALL_TIMEOUT_S = _env_float("LLM_TIMEOUT_MS", 9000.0) / 1000.0
TOTAL_BUDGET_S = _env_float("LLM_TOTAL_BUDGET_S", 18.0)
CACHE_SIZE = 2048
MAX_OUTPUT_TOKENS = int(os.getenv("LLM_MAX_OUTPUT_TOKENS", "600"))

PROVIDERS = {
    "groq": {"key_env": "GROQ_API_KEY"},
    "cerebras": {"key_env": "CEREBRAS_API_KEY", "base_url": "https://api.cerebras.ai/v1"},
    "openai_compat": {"key_env": "OPENAI_API_KEY"},
    "gemini": {"key_env": "GEMINI_API_KEY"},
    "ollama": {"key_env": None},  # no key needed
}


class LLMUnavailable(Exception):
    """Every configured model failed (network, rate limit, bad output)."""


def _split_env(name: str, default: str = "") -> list[str]:
    return [m.strip() for m in os.getenv(name, default).split(",") if m.strip()]


def _models() -> list[tuple[str, str]]:
    """Ordered (provider, model) chain; providers without an API key are skipped."""
    if os.getenv("LLM_CHAIN"):
        chain = [tuple(e.split(":", 1)) for e in _split_env("LLM_CHAIN") if ":" in e]
    else:
        chain: list[tuple[str, str]] = []
        # 1. Groq primary (new name, else legacy OPENAI_* pointing at groq)
        groq_model = os.getenv("GROQ_MODEL", "").strip()
        openai_base = os.getenv("OPENAI_BASE_URL", "")
        openai_model = os.getenv("OPENAI_MODEL", "").strip()
        if groq_model:
            chain.append(("groq", groq_model))
        elif os.getenv("GROQ_API_KEY"):
            chain.append(("groq", "openai/gpt-oss-120b"))
        if os.getenv("OPENAI_API_KEY") and openai_model:
            # legacy gridwise-api: OPENAI_* is actually Groq (base_url api.groq.com)
            chain.append(("openai_compat", openai_model))
        # 2. Cerebras high-throughput backstop
        chain += [("cerebras", m) for m in _split_env("CEREBRAS_MODELS", "qwen-3.8-27b,gpt-oss-120b")]
        # 3. Groq fallbacks
        chain += [("groq", m) for m in _split_env("GROQ_FALLBACK_MODELS")]
        if not groq_model and not os.getenv("GROQ_FALLBACK_MODELS") and os.getenv("GROQ_API_KEY"):
            # default small-model fallbacks when nothing else configured
            chain += [("groq", "openai/gpt-oss-20b"), ("groq", "qwen/qwen3-32b")]
        # 4. Gemini backup (legacy name)
        if os.getenv("GEMINI_API_KEY"):
            chain.append(("gemini", os.getenv("GEMINI_MODEL", "gemini-2.0-flash").strip()))
        # 5. Local Ollama
        if os.getenv("OLLAMA_BASE_URL"):
            chain.append(("ollama", os.getenv("OLLAMA_MODEL", "llama3.1:8b").strip()))
    out: list[tuple[str, str]] = []
    for provider, model in chain:
        cfg = PROVIDERS.get(provider)
        if not cfg or (provider, model) in out:
            continue
        key_env = cfg.get("key_env")
        if provider == "ollama":
            if not os.getenv("OLLAMA_BASE_URL"):
                continue
        elif key_env and not os.getenv(key_env):
            continue
        out.append((provider, model))
    return out


_clients: dict[str, object] = {}
_client_lock = threading.Lock()


def _get_client(provider: str):
    if provider not in _clients:
        with _client_lock:
            if provider not in _clients:
                if provider == "groq":
                    from groq import Groq

                    _clients[provider] = Groq(
                        api_key=os.getenv("GROQ_API_KEY"), timeout=PER_CALL_TIMEOUT_S, max_retries=0
                    )
                elif provider in ("cerebras", "openai_compat"):
                    from openai import OpenAI

                    if provider == "cerebras":
                        _clients[provider] = OpenAI(
                            api_key=os.getenv("CEREBRAS_API_KEY"),
                            base_url="https://api.cerebras.ai/v1",
                            timeout=PER_CALL_TIMEOUT_S,
                            max_retries=0,
                        )
                    else:
                        _clients[provider] = OpenAI(
                            api_key=os.getenv("OPENAI_API_KEY"),
                            base_url=os.getenv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1"),
                            timeout=PER_CALL_TIMEOUT_S,
                            max_retries=0,
                        )
    return _clients.get(provider)


class _LRU:
    def __init__(self, size: int):
        self.size, self.data, self.lock = size, OrderedDict(), threading.Lock()

    def get(self, k):
        with self.lock:
            if k in self.data:
                self.data.move_to_end(k)
                return self.data[k]
        return None

    def put(self, k, v):
        with self.lock:
            self.data[k] = v
            self.data.move_to_end(k)
            while len(self.data) > self.size:
                self.data.popitem(last=False)


_cache = _LRU(CACHE_SIZE)

# (provider, model) -> monotonic time until which it is skipped after a 429
_cooldown: dict[tuple[str, str], float] = {}
DEFAULT_COOLDOWN_S = 20.0


def _retry_after(exc: Exception) -> float:
    try:
        return min(60.0, float(exc.response.headers.get("retry-after")))  # type: ignore[attr-defined]
    except Exception:
        return DEFAULT_COOLDOWN_S


def _cache_key(note: str) -> str:
    return " ".join(note.split()).lower()


def _reasoning_kwargs(provider: str, model: str) -> dict:
    if "gpt-oss" in model:
        return {"reasoning_effort": "low"}
    if provider == "cerebras" and "qwen" in model:
        # Cerebras qwen reasons by default and the thinking tokens would exhaust the output cap
        return {"reasoning_effort": "none"}
    return {}


def _call_openai_style(provider: str, model: str, notes: list[str], timeout: float) -> list[dict]:
    client = _get_client(provider)
    kwargs: dict = dict(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message(notes)},
        ],
        temperature=0,
        max_completion_tokens=MAX_OUTPUT_TOKENS,
        timeout=timeout,
        **_reasoning_kwargs(provider, model),
    )
    # Groq + Cerebras support strict json_schema; legacy compat uses json_object
    if provider in ("groq", "cerebras"):
        kwargs["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "note_interpretations", "schema": RESPONSE_SCHEMA, "strict": True},
        }
    else:
        kwargs["response_format"] = {"type": "json_object"}
    resp = client.chat.completions.create(**kwargs)
    content = resp.choices[0].message.content or ""
    data = json.loads(content)
    items = data.get("interpretations", data if isinstance(data, list) else None)
    if not isinstance(items, list):
        # legacy prompt asked for a bare array
        raise ValueError("bad LLM JSON shape")
    return items


def _call_gemini(model: str, notes: list[str], timeout: float) -> list[dict]:
    import urllib.parse

    key = os.getenv("GEMINI_API_KEY", "")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(key)}"
    prompt = SYSTEM_PROMPT + "\n\n" + user_message(notes) + "\n\nReturn ONLY JSON: {\"interpretations\": [...]}"
    body = json.dumps(
        {
            "generationConfig": {
                "temperature": 0,
                "maxOutputTokens": MAX_OUTPUT_TOKENS,
                "responseMimeType": "application/json",
            },
            "contents": [{"parts": [{"text": prompt}]}],
        }
    ).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    text = "".join(p.get("text", "") for p in data.get("candidates", [{}])[0].get("content", {}).get("parts", []))
    if not text:
        raise ValueError("empty gemini response")
    cleaned = text.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        s, e = cleaned.find("{"), cleaned.rfind("}")
        parsed = json.loads(cleaned[s : e + 1])
    items = parsed.get("interpretations", parsed if isinstance(parsed, list) else None)
    if not isinstance(items, list):
        raise ValueError("bad gemini JSON shape")
    return items


def _call_ollama(model: str, notes: list[str], timeout: float) -> list[dict]:
    base = os.getenv("OLLAMA_BASE_URL", "").rstrip("/")
    body = json.dumps(
        {
            "model": model,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_message(notes)},
            ],
        }
    ).encode()
    req = urllib.request.Request(f"{base}/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    text = (data.get("message") or {}).get("content", "")
    parsed = json.loads(text)
    items = parsed.get("interpretations", parsed if isinstance(parsed, list) else None)
    if not isinstance(items, list):
        raise ValueError("bad ollama JSON shape")
    return items


def _call_model(provider: str, model: str, notes: list[str], timeout: float) -> list[dict]:
    if provider in ("groq", "cerebras", "openai_compat"):
        items = _call_openai_style(provider, model, notes, timeout)
    elif provider == "gemini":
        items = _call_gemini(model, notes, timeout)
    elif provider == "ollama":
        items = _call_ollama(model, notes, timeout)
    else:
        raise ValueError(f"unknown provider {provider}")
    if not isinstance(items, list) or len(items) != len(notes):
        raise ValueError("wrong number of interpretations")
    by_idx = {}
    for it in items:
        idx = it.get("note_index")
        if not isinstance(idx, int) or not 0 <= idx < len(notes) or idx in by_idx:
            raise ValueError("bad note_index mapping")
        check_item(it)  # guardrail failure -> caller falls through to the next model
        by_idx[idx] = it
    return [by_idx[i] for i in range(len(notes))]


def interpret_notes(notes: list[str]) -> tuple[list[dict], str]:
    """Returns (raw LLM items aligned to notes, model label). Raises LLMUnavailable."""
    results: list[dict | None] = [_cache.get(_cache_key(n)) for n in notes]
    missing = [i for i, r in enumerate(results) if r is None]
    if not missing:
        return [dict(r) for r in results], "cache"

    models = _models()
    if not models:
        raise LLMUnavailable("no LLM provider key configured")
    deadline = time.monotonic() + TOTAL_BUDGET_S
    now = time.monotonic()
    ready = [m for m in models if _cooldown.get(m, 0) <= now]
    last_err = "no model available"
    # if everything is cooling down, still try them all rather than fail outright
    for provider, model in ready or models:
        remaining = deadline - time.monotonic()
        if remaining < 1.5:
            break
        label = f"{provider}:{model}"
        try:
            t0 = time.monotonic()
            items = _call_model(provider, model, [notes[i] for i in missing], min(PER_CALL_TIMEOUT_S, remaining))
            log.info("llm ok model=%s notes=%d %.2fs", label, len(missing), time.monotonic() - t0)
            for i, it in zip(missing, items):
                it = {k: v for k, v in it.items() if k != "note_index"}
                _cache.put(_cache_key(notes[i]), it)
                results[i] = it
            return [dict(r) for r in results], label
        except LLMUnavailable:
            raise
        except Exception as exc:  # rate limit, timeout, bad JSON, schema error -> next model
            last_err = type(exc).__name__
            if last_err == "RateLimitError":
                _cooldown[(provider, model)] = time.monotonic() + _retry_after(exc)
            log.warning("llm failed model=%s err=%s", label, last_err)
    raise LLMUnavailable(last_err)
