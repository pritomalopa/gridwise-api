# GridWise API — BUP CSE Fest 2026 (Preliminary)

LLM-assisted smart-campus energy optimization service. Receives a 24-hour scenario + 1–3 operator notes, interprets notes with an LLM, validates deterministically, applies directives to an LP optimizer, and returns a valid minimum-cost 24-hour schedule.

- `GET /health` → `{"status":"ok"}`
- `POST /optimize-energy` → interpretation + 24h plan (see Problem Statement §10)

## Architecture

```
operator_notes ──▶ LLM (OpenAI-compatible / Gemini / Ollama)
                        │  strict JSON prompt (hours, factor, reserve, caps, no_op)
                        ▼
               Deterministic guardrails (src/interpret.js)
                - allowed types only · note_index 0..N-1 · hours sorted 0-23
                - factor 0..1 · reserve ≤ capacity · grid cap ≥ 0
                - no_op ⟺ applies=false + null · others ⟺ applies=true
                - invalid LLM output → heuristic fallback (safe failure, never crash)
                        ▼
               LP optimizer (src/optimizer.js, javascript-lp-solver)
                - effective solar · reserve · no-charge/discharge · grid caps
                - energy balance · battery bounds/rates · end-of-day neutrality
                - minimize Σ grid×tariff · re-derive grid from balance · verify plan
```

**LLM role (mandatory requirement):** the language model directly produces the `directive_interpretation` that the optimizer consumes. It is not used only for `plan_summary`/docs. When no provider key is configured the service uses a paraphrase-tolerant heuristic fallback so local tests pass offline — but for judging, set one of the keys below so the real LLM path is active.

**Credits:** Express, `javascript-lp-solver` (LP), `dotenv`, `cors`. AI coding assistant used for scaffolding; core LLM→guardrail→optimizer logic is original.

## Quickstart (clean machine)

```bash
git clone <your-repo> && cd gridwise-api
npm install
cp .env.example .env   # then set ONE provider key (see below)
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
curl -X POST http://localhost:3000/optimize-energy -H "Content-Type: application/json" --data @sample01.json
```

Full public-sample test (expects 10/10):

```bash
npm test
# or against a deployed URL:
BASE_URL=https://<your-service> npm test
```

## Configuration (environment variables, no secrets in repo)

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL` | OpenAI-compatible LLM (OpenAI / **Groq free tier** `https://api.groq.com/openai/v1` + `llama-3.1-8b-instant` / Together / OpenRouter) | — |
| `GEMINI_API_KEY` + `GEMINI_MODEL` | Google Gemini (**free tier** `gemini-2.0-flash`) | — |
| `OLLAMA_BASE_URL` + `OLLAMA_MODEL` | Local Ollama (no key) | — |
| `LLM_TIMEOUT_MS` | Per-provider timeout (keeps p95 < 5s) | `9000` |

Priority: first configured provider that returns guardrail-valid JSON wins; otherwise heuristic fallback. Never commit `.env`.

Recommended for judging (free + fast): Groq `llama-3.1-8b-instant` or Gemini `gemini-2.0-flash`.

## Docker fallback image

```bash
docker build -t gridwise-api:latest .
docker run -p 3000:3000 --env-file .env gridwise-api:latest
curl http://localhost:3000/health
```

Publish for submission (example, GHCR):

```bash
docker tag gridwise-api:latest ghcr.io/<user>/gridwise-api:v1
docker push ghcr.io/<user>/gridwise-api:v1
# Submit: ghcr.io/<user>/gridwise-api:v1 + run command above. No secrets baked in.
```

## Deploy (public URL for the judge)

Easiest free path — **Render** (Docker):

1. Push repo to GitHub (private during event, public after deadline).
2. Render → New → Web Service → select repo → Runtime **Docker** → set env vars (`OPENAI_*` or `GEMINI_*`).
3. Deploy; judge URL = `https://<service>.onrender.com` (`/health`, `/optimize-energy`).
4. Verify from another network: `curl https://<service>.onrender.com/health`.

Alternatives: Railway / Fly.io / Render-native Node (`npm start`). Any reachable platform is allowed.

## API contract (summary)

Request `POST /optimize-energy`: `{scenario_id, operator_notes[1..3], hours[24]{hour,demand_kwh,solar_kwh,tariff_bdt_per_kwh}, battery{capacity_kwh,initial_energy_kwh,minimum_energy_kwh,max_charge_kwh_per_hour,max_discharge_kwh_per_hour}}` → `400` malformed JSON/structure, `422` semantic (bad ranges), `500` controlled (no stacks/secrets).

Response: `{scenario_id, directive_interpretation[{note_index,applies,directive_type,structured_adjustment,explanation}], hourly_plan[24]{hour,grid_kwh,solar_used_kwh,battery_action, battery_kwh,battery_energy_after_kwh}, total_grid_kwh, total_cost_bdt, peak_grid_kwh, plan_summary}`. Totals are recalculated from `hourly_plan`. Time windows are start-inclusive/end-exclusive; solar factor = fraction remaining.

## Known limitations

- LP assumes ideal battery (no efficiency loss) per the Problem Statement.
- Heuristic fallback covers common paraphrases but the LLM path is required for full robustness — configure a key for judging.
- Simultaneous charge+discharge is netted; tiny solver residuals are snapped to 0.
