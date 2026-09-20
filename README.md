# GridWise API — BUP CSE Fest 2026 (Preliminary)

LLM-assisted smart-campus energy optimization service. Receives a 24-hour scenario + 1–3 operator notes, interprets notes with an LLM, validates deterministically, applies directives to an LP optimizer, and returns a valid minimum-cost 24-hour schedule.

| Item | Value |
|---|---|
| Base URL (judge) | `https://gridwise-api-4hp0.onrender.com` |
| Health endpoint | `GET /health` → `{"status":"ok"}` |
| Main endpoint | `POST /optimize-energy` |
| GitHub repository | `https://github.com/pritomalopa/gridwise-api` |
| Docker fallback image | `ghcr.io/pritomalopa/gridwise-api:v1` (digest `sha256:cdbe7a1b0019fbeb2975867a7d8f0d1db2ec4b3887b37b5145e38942dc2bd665`) |
| 3-minute video | _(Drive link will be added here)_ |
| Public-sample result | **10/10 interpretation PASS, 10/10 validity PASS, cost ratio 1.000 on all cases** |

## Architecture

```
operator_notes ──▶ LLM (OpenAI-compatible / Gemini / Ollama)
                        │  strict JSON prompt (hours, factor, reserve, caps, no_op)
                        ▼
               Deterministic guardrails (src/interpret.js)
                - allowed types only · note_index 0..N-1 · hours sorted 0-23
                - factor 0..1 · reserve ≤ capacity · grid cap ≥ 0
                - no_op ⟺ applies=false + null · others ⟺ applies=true
                - invalid LLM output → retry → next provider → heuristic fallback (never crash)
                        ▼
               LP optimizer (src/optimizer.js, javascript-lp-solver)
                - effective solar · reserve · no-charge/discharge · grid caps
                - energy balance · battery bounds/rates · end-of-day neutrality
                - minimize Σ grid×tariff · re-derive grid from balance · verify plan
```

**LLM role (mandatory requirement):** the language model directly produces the `directive_interpretation` that the optimizer consumes. It is not used only for `plan_summary`/docs. When no provider key is configured the service uses a paraphrase-tolerant heuristic fallback so local tests pass offline — but for judging, a provider key is set (see Configuration) so the real LLM path is active.

**Model/provider:** primary Groq `llama-3.1-8b-instant` (OpenAI-compatible, free tier, ~1–2s latency), backup Gemini `gemini-2.0-flash` (free tier). First configured provider returning guardrail-valid JSON wins.

**Credits:** Express, `javascript-lp-solver` (LP), `dotenv`, `cors`. AI coding assistant used for scaffolding; core LLM→guardrail→optimizer logic is original.

## Quickstart (clean machine)

```bash
git clone https://github.com/pritomalopa/gridwise-api.git && cd gridwise-api
npm install
cp .env.example .env   # then set ONE provider key (see Configuration)
npm start              # listens on 0.0.0.0:3000
```

Health:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Optimize (one public sample):

```bash
# PowerShell: extract SAMPLE-01 input and POST it
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.md','utf8'));fs.writeFileSync('sample01.json',JSON.stringify(p.cases[0].input))"
curl.exe -X POST http://localhost:3000/optimize-energy -H "Content-Type: application/json" --data "@sample01.json"
```

> Windows PowerShell note: `curl` alone is an alias for `Invoke-WebRequest` — always use `curl.exe` for the commands above.

Full public-sample test (expects 10/10):

```bash
npm test
# against the live deployment:
$env:BASE_URL="https://gridwise-api-4hp0.onrender.com"; npm test
```

## Configuration (environment variables, no secrets in repo)

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL` | OpenAI-compatible LLM — judging uses Groq free tier `https://api.groq.com/openai/v1` + `llama-3.1-8b-instant` | base/model as shown, key empty |
| `GEMINI_API_KEY` + `GEMINI_MODEL` | Backup: Google Gemini free tier `gemini-2.0-flash` | model as shown, key empty |
| `OLLAMA_BASE_URL` + `OLLAMA_MODEL` | Local Ollama (no key) | empty / `llama3.1:8b` |
| `LLM_TIMEOUT_MS` | Per-provider timeout (keeps p95 < 5s) | `9000` |
| `LLM_MAX_RETRIES` | Retries per provider before falling to next provider | `1` |

Priority: first configured provider that returns guardrail-valid JSON wins; otherwise heuristic fallback. Never commit `.env` (it is gitignored; the image contains no baked-in secrets).

## Docker fallback image

Run the exact submitted image:

```bash
docker pull ghcr.io/pritomalopa/gridwise-api:v1
docker run -p 3000:3000 --env-file .env ghcr.io/pritomalopa/gridwise-api:v1
curl http://localhost:3000/health
# {"status":"ok"}
```

Rebuild from source:

```bash
docker build -t gridwise-api:latest .
docker run -p 3000:3000 --env-file .env gridwise-api:latest
```

## Deploy (live judge URL)

The service is deployed on **Render** (Node runtime, Singapore region, auto-deploy on push to `main`):

- Base URL: `https://gridwise-api-4hp0.onrender.com`
- Verify: `curl https://gridwise-api-4hp0.onrender.com/health`
- Full check: `$env:BASE_URL="https://gridwise-api-4hp0.onrender.com"; npm test` → 10/10

Note: Render free tier sleeps after ~15 min idle, so the first request can take ~10s (cold start); subsequent requests are ~1s. Required env vars (`OPENAI_*` / `GEMINI_*`) are set in the Render dashboard, not in the repo.

## API contract (summary)

Request `POST /optimize-energy`: `{scenario_id, operator_notes[1..3], hours[24]{hour,demand_kwh,solar_kwh,tariff_bdt_per_kwh}, battery{capacity_kwh,initial_energy_kwh,minimum_energy_kwh,max_charge_kwh_per_hour,max_discharge_kwh_per_hour}}` → `400` malformed JSON/structure, `422` semantic (bad ranges), `500` controlled (no stacks/secrets).

Response: `{scenario_id, directive_interpretation[{note_index,applies,directive_type,structured_adjustment,explanation}], hourly_plan[24]{hour,grid_kwh,solar_used_kwh,battery_action,battery_kwh,battery_energy_after_kwh}, total_grid_kwh, total_cost_bdt, peak_grid_kwh, plan_summary}`. Totals are recalculated from `hourly_plan`. Time windows are start-inclusive/end-exclusive; solar factor = fraction remaining.

## Known limitations

- LP assumes ideal battery (no efficiency loss) per the Problem Statement.
- Heuristic fallback covers common paraphrases but the live LLM path is used for judging — provider key is configured on Render.
- Simultaneous charge+discharge is netted; tiny solver residuals are snapped to 0.
- Render free-tier cold start (~10s) applies only to the first request after idle.
