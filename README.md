# GridWise API — BUP CSE Fest 2026 (Preliminary, Python)

LLM-assisted smart-campus energy optimization service. Receives a 24-hour scenario + 1–3 operator notes, interprets notes with an LLM, validates deterministically, applies directives to an LP optimizer, and returns a valid minimum-cost 24-hour schedule.

| Item | Value |
|---|---|
| Base URL (judge) | `https://gridwise-api-4hp0.onrender.com` |
| Health endpoint | `GET /health` → `{"status":"ok"}` |
| Main endpoint | `POST /optimize-energy` |
| GitHub repository | `https://github.com/pritomalopa/gridwise-api` |
| Docker fallback image | `ghcr.io/pritomalopa/gridwise-api:v2` (rebuild after Python migration; digest updated on release) |
| 3-minute video | _(Drive link will be added here)_ |
| Public-sample result | **10/10 interpretation PASS, 10/10 validity PASS, cost == reference on all cases (p95 ~1.5s)** |

## Architecture

```
operator_notes ──▶ LLM (Groq primary + Cerebras backstop, legacy OPENAI/Gemini/Ollama kept)
                        │  strict JSON schema: type + windows [[start,end)] + value/unit
                        ▼
               Deterministic guardrails (app/guardrails.py)
                - LLM does language, code does arithmetic (windows→hours, %→factor/kWh)
                - allowed types only · note_index 0..N-1 · hours sorted 0-23
                - factor 0..1 · reserve ≤ capacity · grid cap ≥ 0
                - no_op ⟺ applies=false + null · others ⟺ applies=true
                - invalid LLM output → next model → safe no_op (never invent, never crash)
                        ▼
               LP optimizer (app/optimizer.py, HiGHS via scipy.linprog)
                - effective solar · reserve · no-charge/discharge · grid caps
                - energy balance · battery bounds/rates · end-of-day neutrality
                - minimize Σ grid×tariff · net + round + recompute · self-check replay
```

**LLM role (mandatory requirement):** the language model directly produces the `directive_interpretation` that the optimizer consumes. It is not used only for `plan_summary`/docs. When no provider key is configured the service uses a paraphrase-tolerant rule parser so local tests pass offline (10/10 fallback-only) — but for judging, a provider key is set so the real LLM path is active.

**Model/provider:** primary Groq `openai/gpt-oss-120b` (free tier, strict `json_schema`), backstop Cerebras `qwen-3.8-27b` (450 req/min). Legacy env (`OPENAI_*` pointing at Groq, `GEMINI_*`, `OLLAMA_*`) still works so the existing Render deployment needs no dashboard change. First configured provider returning guardrail-valid JSON wins (per-model 429 cooldown, 8s/call, 18s total budget, LRU cache).

**Credits:** FastAPI, Pydantic, `scipy.optimize.linprog` (HiGHS), NumPy, Groq + OpenAI SDKs, python-dotenv, pytest. Learned from the qualified `bup-hackathon-preli` build (CleanPass: LLM-does-language/code-does-arithmetic, multi-provider chain, guardrails, LP + replay).

## Quickstart (clean machine)

```bash
git clone https://github.com/pritomalopa/gridwise-api.git && cd gridwise-api
python -m venv .venv
# Windows: .venv\Scripts\activate | Linux/Mac: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env   # then set GROQ_API_KEY (and optionally CEREBRAS_API_KEY)
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Health:

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

Optimize (one public sample):

```powershell
# Windows PowerShell: extract SAMPLE-01 input and POST it
python -c "import json; json.dump(json.load(open('BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json'))['cases'][0]['input'], open('sample01.json','w'))"
curl.exe -X POST http://localhost:8000/optimize-energy -H "Content-Type: application/json" --data "@sample01.json"
```

Full public-sample test (expects 10/10):

```bash
python scripts/run_samples.py --base-url http://localhost:8000
# against the live deployment:
# $env:BASE_URL="https://gridwise-api-4hp0.onrender.com"; python scripts/run_samples.py --base-url https://gridwise-api-4hp0.onrender.com
```

Unit + API tests (offline, no key needed):

```bash
pytest -q   # 76 passed
```

Paraphrase robustness (needs `GROQ_API_KEY`):

```bash
python scripts/eval_llm.py
```

## Configuration (environment variables, no secrets in repo)

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `8000` |
| `GROQ_API_KEY` + `GROQ_MODEL` + `GROQ_FALLBACK_MODELS` | Primary LLM (Groq free tier) | `openai/gpt-oss-120b` + fallbacks |
| `CEREBRAS_API_KEY` + `CEREBRAS_MODELS` | Backstop: Cerebras free tier | `qwen-3.8-27b,gpt-oss-120b` |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL` | Legacy OpenAI-compatible (Render currently uses Groq via this) | base/model as shown, key empty |
| `GEMINI_API_KEY` + `GEMINI_MODEL` | Backup: Google Gemini free tier | `gemini-2.0-flash`, key empty |
| `OLLAMA_BASE_URL` + `OLLAMA_MODEL` | Local Ollama (no key) | empty / `llama3.1:8b` |
| `LLM_CHAIN` | Explicit override, e.g. `groq:openai/gpt-oss-120b,cerebras:qwen-3.8-27b` | built from above |
| `LLM_TIMEOUT_S` | Per-provider timeout (keeps p95 < 5s) | `8` |
| `LLM_TOTAL_BUDGET_S` | Total LLM budget per request (judge timeout 30s) | `18` |
| `LLM_MAX_OUTPUT_TOKENS` | Output token cap per call | `600` |
| `WEB_CONCURRENCY` | Uvicorn workers | `1` |

Priority: first configured provider that returns guardrail-valid JSON wins; otherwise rule-parser fallback (flagged in `explanation`). Never commit `.env` (gitignored; the image contains no baked-in secrets).

## Docker fallback image

Run the exact submitted image:

```bash
docker pull ghcr.io/pritomalopa/gridwise-api:v2
docker run -p 8000:8000 --env-file .env ghcr.io/pritomalopa/gridwise-api:v2
curl http://localhost:8000/health
# {"status":"ok"}
```

Rebuild from source:

```bash
docker build -t gridwise-api:latest .
docker run -p 8000:8000 --env-file .env gridwise-api:latest
# or: docker compose up --build
```

## Deploy (live judge URL)

The service is deployed on **Render** (Singapore region, auto-deploy on push to `main`):

- Base URL: `https://gridwise-api-4hp0.onrender.com`
- Verify: `curl https://gridwise-api-4hp0.onrender.com/health`
- Full check: `python scripts/run_samples.py --base-url https://gridwise-api-4hp0.onrender.com` → 10/10
- Render env: set `GROQ_API_KEY` (new, recommended) — legacy `OPENAI_*`/`GEMINI_*` already set and still work. Redeploy after merging Python migration (Node `npm start` → Python `uvicorn app.main:app`, port 3000 → 8000).
- Dockerfile: `python:3.12-slim`, non-root user, `HEALTHCHECK`, `.dockerignore` excludes `.env`.

Note: Render free tier sleeps after ~15 min idle, so the first request can take ~10s (cold start); subsequent requests are ~1s.

## API contract (summary)

Request `POST /optimize-energy`: `{scenario_id, operator_notes[1..3], hours[24]{hour,demand_kwh,solar_kwh,tariff_bdt_per_kwh}, battery{capacity_kwh,initial_energy_kwh,minimum_energy_kwh,max_charge_kwh_per_hour,max_discharge_kwh_per_hour}}` → `400` malformed JSON/structure, `422` base-infeasible, `500` controlled (no stacks/secrets).

Response: `{scenario_id, directive_interpretation[{note_index,applies,directive_type,structured_adjustment,explanation}], hourly_plan[24]{hour,grid_kwh,solar_used_kwh,battery_action,battery_kwh,battery_energy_after_kwh}, total_grid_kwh, total_cost_bdt, peak_grid_kwh, plan_summary}`. Totals are recalculated from `hourly_plan`. Time windows are start-inclusive/end-exclusive; solar factor = fraction remaining.

## Known limitations

- LP assumes ideal battery (no efficiency loss) per the Problem Statement.
- Weak/small LLM models can confuse grid-cap vs reserve phrasing — prompt pins "grid+cap → always max_grid"; use `GROQ_MODEL=openai/gpt-oss-120b` for best accuracy.
- Simultaneous charge+discharge is netted; tiny solver residuals are snapped to 0.
- Infeasible directive sets (shouldn't happen per organizers) return a minimum-violation plan flagged in `plan_summary`, never 500.
- Render free-tier cold start (~10s) applies only to the first request after idle.
