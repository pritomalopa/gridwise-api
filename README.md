# GridWise — LLM-Assisted Smart Campus Energy Optimization

Submission for the **BUP CSE Fest 2026 Hackathon — Online Preliminary Round**.

One HTTP service that reads a 24-hour campus energy scenario plus 1–3 natural-language
operator notes, interprets those notes with a language model, validates the
interpretation with deterministic guardrails, applies the resulting directives to a
linear-programming scheduler, and returns a valid, cost-minimal 24-hour plan.

| | |
|---|---|
| Health endpoint | `GET /health` → `{"status":"ok"}` |
| Main endpoint | `POST /optimize-energy` |
| Runtime | Node.js 20+, TypeScript, Express 5 |
| Model provider | Anthropic Claude (default) or OpenAI — configurable |
| Default model | `claude-sonnet-5` |
| Optimizer | Linear programming via `javascript-lp-solver` |
| Docker image | `pritomalopa/gridwise-api:1.0.0` (DockerHub, single-stage) |

> **Minimal backend:** This service has **no database** and **no frontend**.
> `GET /health` and `POST /optimize-energy` are the only routes. No dashboard, no history API.

---

## 1. Quickstart from a clean machine

Requires only Node.js 20 or newer and one model API key.

```bash
# 1. get the code
git clone <REPO URL>
cd gridwise-api

# 2. install dependencies
npm ci

# 3. configure the model provider
cp .env.example .env
#    then open .env and set ANTHROPIC_API_KEY=sk-ant-...

# 4. build and start
npm run build
npm start
# -> GridWise API listening on 0.0.0.0:8080 | provider=anthropic model=claude-sonnet-5 key=configured
```

Verify readiness:

```bash
curl -s http://localhost:8080/health
# {"status":"ok"}
```

**Local dev (hot reload):**

```bash
npm run dev   # tsx watch src/server.ts -> http://localhost:8080
```

Run one public sample end to end:

```bash
curl -s -X POST http://localhost:8080/optimize-energy \
  -H 'Content-Type: application/json' \
  -d '{
    "scenario_id": "GRID-DEMO",
    "operator_notes": [
      "Expect an 80% reduction in rooftop solar between 11 AM and 2 PM because of inverter work.",
      "The student affairs office will publish club notices tomorrow."
    ],
    "hours": [
      {"hour":0,"demand_kwh":90,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":1,"demand_kwh":85,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":2,"demand_kwh":80,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":3,"demand_kwh":80,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":4,"demand_kwh":85,"solar_kwh":0,"tariff_bdt_per_kwh":5},
      {"hour":5,"demand_kwh":95,"solar_kwh":0,"tariff_bdt_per_kwh":6},
      {"hour":6,"demand_kwh":105,"solar_kwh":5,"tariff_bdt_per_kwh":8},
      {"hour":7,"demand_kwh":120,"solar_kwh":25,"tariff_bdt_per_kwh":10},
      {"hour":8,"demand_kwh":135,"solar_kwh":65,"tariff_bdt_per_kwh":12},
      {"hour":9,"demand_kwh":150,"solar_kwh":120,"tariff_bdt_per_kwh":13},
      {"hour":10,"demand_kwh":165,"solar_kwh":180,"tariff_bdt_per_kwh":14},
      {"hour":11,"demand_kwh":175,"solar_kwh":230,"tariff_bdt_per_kwh":15},
      {"hour":12,"demand_kwh":180,"solar_kwh":260,"tariff_bdt_per_kwh":15},
      {"hour":13,"demand_kwh":175,"solar_kwh":240,"tariff_bdt_per_kwh":14},
      {"hour":14,"demand_kwh":165,"solar_kwh":190,"tariff_bdt_per_kwh":13},
      {"hour":15,"demand_kwh":160,"solar_kwh":120,"tariff_bdt_per_kwh":14},
      {"hour":16,"demand_kwh":170,"solar_kwh":55,"tariff_bdt_per_kwh":18},
      {"hour":17,"demand_kwh":185,"solar_kwh":10,"tariff_bdt_per_kwh":22},
      {"hour":18,"demand_kwh":200,"solar_kwh":0,"tariff_bdt_per_kwh":27},
      {"hour":19,"demand_kwh":210,"solar_kwh":0,"tariff_bdt_per_kwh":29},
      {"hour":20,"demand_kwh":200,"solar_kwh":0,"tariff_bdt_per_kwh":26},
      {"hour":21,"demand_kwh":170,"solar_kwh":0,"tariff_bdt_per_kwh":18},
      {"hour":22,"demand_kwh":135,"solar_kwh":0,"tariff_bdt_per_kwh":10},
      {"hour":23,"demand_kwh":105,"solar_kwh":0,"tariff_bdt_per_kwh":7}
    ],
    "battery": {
      "capacity_kwh": 240,
      "initial_energy_kwh": 120,
      "minimum_energy_kwh": 40,
      "max_charge_kwh_per_hour": 60,
      "max_discharge_kwh_per_hour": 60
    }
  }'
```

Expected shape of the reply (values abbreviated):

```json
{
  "scenario_id": "GRID-DEMO",
  "directive_interpretation": [
    { "note_index": 0, "applies": true, "directive_type": "solar_reduction",
      "structured_adjustment": { "hours": [11, 12, 13], "factor": 0.2 },
      "explanation": "An 80% reduction leaves 20% of usable solar." },
    { "note_index": 1, "applies": false, "directive_type": "no_op",
      "structured_adjustment": null,
      "explanation": "This note does not affect today's 24-hour energy schedule." }
  ],
  "hourly_plan": [ { "hour": 0, "grid_kwh": 90, "solar_used_kwh": 0,
                     "battery_action": "idle", "battery_kwh": 0,
                     "battery_energy_after_kwh": 120 }, "... 23 more ..." ],
  "total_grid_kwh": 2504,
  "total_cost_bdt": 34873,
  "peak_grid_kwh": 170,
  "plan_summary": "Applied reduced usable solar; 1 unrelated note was ignored; ..."
}
```

---

## 2. Environment variables

No secret values appear anywhere in this repository. Only names are documented.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes (Anthropic) | — | Key for the Claude Messages API |
| `OPENAI_API_KEY` | yes (OpenAI) | — | Key when `LLM_PROVIDER=openai` |
| `LLM_PROVIDER` | no | `anthropic` | `anthropic` or `openai` |
| `LLM_MODEL` | no | `claude-sonnet-5` | Model id. `claude-haiku-4-5-20251001` is a faster alternative |
| `PORT` | no | `8080` | Bind port; the service always binds `0.0.0.0` |
| `LLM_TIMEOUT_MS` | no | `12000` | Hard timeout on a single model call |
| `LLM_MAX_RETRIES` | no | `1` | Extra attempts after a failed model call |
| `LLM_CACHE` | no | `true` | In-memory cache of note → directive, keeps p95 latency low |
| `LLM_CACHE_SIZE` | no | `500` | Cache entries retained |
| `ANTHROPIC_BASE_URL` | no | — | Optional gateway/proxy override |

> **Where to get the key:** Anthropic Console → https://console.anthropic.com → API Keys → Create Key.
> OpenAI alternative: https://platform.openai.com/api-keys

---

## 3. Architecture: LLM → guardrails → optimizer

```
POST /optimize-energy
        │
        ▼
 ┌──────────────────────┐   structural validation; anything malformed is a 400
 │ requestSchema.ts     │
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   MANDATORY LLM STEP
 │ llm/interpretNotes   │   operator_notes ──► untrusted structured JSON
 │ llm/prompt.ts        │   temperature 0, timeout, one retry, LRU cache
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   DETERMINISTIC GUARDRAILS
 │ guardrails/          │   • only the six supported directive_type values
 │ validateDirectives   │   • exactly one entry per note, in note_index order
 │                      │   • hours: unique integers 0–23, ascending
 │                      │   • factor ∈ [0,1]; reserve ∈ [0, capacity]; grid cap ≥ 0
 │                      │   • applies semantics enforced, never trusted
 │                      │   • anything that fails becomes a safe no_op
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   effective_solar, active reserve, charge/discharge
 │ optimizer/           │   blocks and grid caps as 24-length arrays
 │ applyDirectives      │
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   LINEAR PROGRAM, minimise Σ grid_kwh[h] × tariff[h]
 │ optimizer/           │   variables g[h], s[h], c[h], d[h]
 │ solveSchedule        │   battery state as a cumulative net so the LP stays linear
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐   FINAL REPLAY: the schedule is re-checked hour by hour
 │ optimizer/replay     │   against every directive before it is returned
 └──────────┬───────────┘
            ▼
    JSON response (totals recomputed from hourly_plan)
```

### The LP formulation

For each hour `h` the model has four non-negative variables: grid import `g[h]`,
usable solar `s[h]`, battery charge `c[h]` and battery discharge `d[h]`.

```
minimise   Σ g[h] · tariff[h]

subject to g[h] + s[h] + d[h] − c[h] = demand[h]              (energy balance)
           0 ≤ s[h] ≤ effective_solar[h]                       (solar after solar_reduction)
           0 ≤ c[h] ≤ max_charge[h]                            (0 inside a no_charge_window)
           0 ≤ d[h] ≤ max_discharge[h]                         (0 inside a no_discharge_window)
           0 ≤ g[h] ≤ max_grid[h]                              (max_grid_window)
           reserve[h] − E₀ ≤ Σ(c[k] − d[k]) ≤ capacity − E₀    for k ≤ h  (battery bounds)
           Σ(c[k] − d[k]) = 0 over the full day                (end-of-day neutrality)
```

Battery state is written as a cumulative net rather than as a separate variable per
hour, which keeps the whole problem a single linear program with an exact optimum.
After solving, charge and discharge in the same hour are netted, solar is maximised
for the chosen battery flows, and grid import is recomputed from the balance equation
— so the energy balance holds by construction rather than by rounding luck.

### Correctness before cost

* The finished plan is replayed hour by hour before it leaves the service.
* `total_grid_kwh`, `total_cost_bdt` and `peak_grid_kwh` are recomputed from
  `hourly_plan`, never read back from the solver.
* If a directive set were ever infeasible (a hallucinated constraint, for example),
  the solver relaxes interpreted directives one at a time instead of emitting an
  invalid schedule or a 5xx.

### Safe failure

If the model provider is unreachable, rate-limited or times out, the service logs the
failure and falls back to a small deterministic parser (`llm/fallbackInterpreter.ts`)
so the request still gets a valid, well-formed response instead of a 500. **This is a
safety net only** — the language model is the interpretation path whenever it is
reachable, and the fallback is never consulted while the provider is healthy. The
service never invents a directive type in either path.

---

## 4. Testing

Two suites need no key, no network and no running server:

```bash
npm run test:optimizer   # solves all 10 public sample cases from ground-truth directives
npm run test:edge        # guardrail abuse, infeasible directives, degenerate scenarios
npm test                 # both of the above
```

Expected output of `npm run test:optimizer`:

```
SAMPLE-01  PASS  method=lp cost=38365.00 ref=38365 ratio=1.0000
SAMPLE-02  PASS  method=lp cost=42885.00 ref=42885 ratio=1.0000
SAMPLE-03  PASS  method=lp cost=35480.00 ref=35480 ratio=1.0000
SAMPLE-04  PASS  method=lp cost=40495.00 ref=40495 ratio=1.0000
SAMPLE-05  PASS  method=lp cost=33950.00 ref=33950 ratio=1.0000
SAMPLE-06  PASS  method=lp cost=34090.00 ref=34090 ratio=1.0000
SAMPLE-07  PASS  method=lp cost=38550.00 ref=38550 ratio=1.0000
SAMPLE-08  PASS  method=lp cost=37665.00 ref=37665 ratio=1.0000
SAMPLE-09  PASS  method=lp cost=34873.00 ref=34873 ratio=1.0000
SAMPLE-10  PASS  method=lp cost=41620.00 ref=41620 ratio=1.0000

10/10 optimizer cases passed | avg ratio 1.0000
```

Every case reaches the published reference optimal cost exactly.

The end-to-end suite posts all ten public cases to a running service, compares the
returned `directive_interpretation` with the published ground truth, independently
replays `hourly_plan` against that ground truth, and reports the cost ratio and p95
latency:

```bash
npm start                 # in one terminal
npm run test:samples      # in another

# against a deployed URL
BASE_URL=https://your-app.onrender.com npm run test:samples

# write the ten full request bodies to tests/requests/ for manual curl runs
npm run dump:samples
```

`tests/public-samples.json` stores the ten official cases in compact form (shared
hourly profiles plus per-case notes, battery, expected directives and reference cost);
the runner expands them into full request bodies at run time.

---

## 5. Deployment

### Render (recommended for the submitted endpoint)

1. Push the repository to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Build command `npm ci && npm run build`, start command `npm start`.
4. Health check path `/health`.
5. Add the environment variable `ANTHROPIC_API_KEY` (required, never in git).
6. Deploy, then confirm `GET https://<service>.onrender.com/health` returns
   `{"status":"ok"}` from outside your development machine.

`render.yaml` in the repo root is a blueprint that performs steps 3–5 automatically.
Railway, Fly.io or any Node host works the same way; the service reads `PORT` and
always binds `0.0.0.0`.

> Free Render instances sleep when idle. Hit `/health` once before judging starts so
> the first hidden request does not pay the cold-start cost.

### Docker fallback image

```bash
# build (no frontend step — backend only)
docker build -t <dockerhub-user>/gridwise-api:1.0.0 .

# run locally (the key is passed at run time; nothing is baked into the image)
docker run --rm -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  <dockerhub-user>/gridwise-api:1.0.0

curl -s http://localhost:8080/health   # {"status":"ok"}

# publish
docker login
docker push <dockerhub-user>/gridwise-api:1.0.0
```

The image exposes port **8080**, binds `0.0.0.0`, contains **no** baked-in credentials,
and needs exactly one runtime variable: `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` with
`LLM_PROVIDER=openai`).

---

## 6. API contract

### `GET /health`

`200` → `{"status":"ok"}`

### `POST /optimize-energy`

Request: `scenario_id` (string), `operator_notes` (1–3 non-empty strings), `hours`
(exactly 24 entries with `hour`, `demand_kwh`, `solar_kwh`, `tariff_bdt_per_kwh`),
`battery` (`capacity_kwh`, `initial_energy_kwh`, `minimum_energy_kwh`,
`max_charge_kwh_per_hour`, `max_discharge_kwh_per_hour`).

Response: `scenario_id`, `directive_interpretation` (one entry per note in
`note_index` order), `hourly_plan` (24 entries), `total_grid_kwh`, `total_cost_bdt`,
`peak_grid_kwh`, `plan_summary`.

| Code | When |
|---|---|
| `200` | Successful interpretation + optimization |
| `400` | Malformed JSON or a structurally invalid request |
| `404` | Unknown path |
| `500` | Controlled internal error — body is `{"error":"internal_error"}`, never a stack trace |

Supported `directive_type` values and their `structured_adjustment` shapes:

| `directive_type` | `structured_adjustment` |
|---|---|
| `solar_reduction` | `{"hours":[…], "factor": 0–1}` (fraction of solar that remains) |
| `minimum_battery_reserve` | `{"hours":[…], "minimum_energy_kwh": number}` |
| `no_charge_window` | `{"hours":[…]}` |
| `no_discharge_window` | `{"hours":[…]}` |
| `max_grid_window` | `{"hours":[…], "max_grid_kwh": number}` |
| `no_op` | `null` (with `applies: false`) |

Time windows are start-inclusive and end-exclusive: 1 PM to 3 PM is `[13, 14]`.

---

## 7. Dependencies and credits

| Package | Role |
|---|---|
| [`express`](https://expressjs.com/) | HTTP server |
| [`cors`](https://www.npmjs.com/package/cors) | Cross-origin for local Vite proxy |
| [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) | Claude Messages API client |
| [`javascript-lp-solver`](https://www.npmjs.com/package/javascript-lp-solver) | Linear programming solver (simplex) |
| [`dotenv`](https://www.npmjs.com/package/dotenv) | Local environment loading |
| `typescript`, `tsx`, `@types/*` | Build and dev tooling only |

The OpenAI provider path uses `fetch` against the public chat-completions endpoint and
needs no extra package. An AI coding assistant was used while building this solution;
the architecture, LP formulation, guardrail design and test harness are the team's own
work, and every external library is credited above.

---

## 8. Security

* No API keys, tokens or `.env` files are committed; `.gitignore` and `.dockerignore`
  both exclude them.
* No secret, prompt containing a secret, or raw stack trace is written to logs or to
  any API response. Provider errors are logged as a short message only.
* Errors return a fixed `{"error":"internal_error"}` body.
* Only the synthetic challenge data supplied in the request is used; the service holds
  no persistent state beyond an in-memory note cache.

---

## 9. Known limitations

* The in-memory note cache is per process, so a multi-instance deployment warms up
  independently on each instance.
* Cost optimality depends on the LP solver's floating-point simplex. All outputs are
  rounded to 4 decimal places, far inside the 0.01 judge tolerance, and the plan is
  replayed before it is returned — but pathological inputs with extreme magnitude
  differences could in principle lose precision.
* The deterministic fallback interpreter handles common phrasings only. It exists to
  keep the service responsive during a provider outage, not to match model-quality
  interpretation.
* If interpreted directives were mutually contradictory, the service relaxes them one
  at a time and logs which note was dropped. Organizer scoring scenarios are stated to
  be feasible, so this path should never trigger during judging.
* Latency is dominated by the single model call. `LLM_MODEL=claude-haiku-4-5-20251001`
  trades a little interpretation accuracy for noticeably lower p95 latency.

---

## 10. Repository layout

```
gridwise-api/
├── src/
│   ├── server.ts                      process entry, binds 0.0.0.0
│   ├── app.ts                         express app, /health, /optimize-energy (44 lines)
│   ├── config.ts                      environment configuration (PORT, LLM_PROVIDER, keys)
│   ├── types.ts                       canonical request/response types
│   ├── routes/optimizeEnergy.ts       LLM → guardrails → LP
│   ├── validation/requestSchema.ts    400-level structural validation
│   ├── llm/prompt.ts                  system prompt and conventions
│   ├── llm/interpretNotes.ts          Anthropic/OpenAI call, timeout, retry, cache
│   ├── llm/fallbackInterpreter.ts     provider-outage safety net
│   ├── guardrails/validateDirectives.ts  deterministic validation and repair
│   ├── optimizer/applyDirectives.ts   directives → per-hour constraints
│   ├── optimizer/solveSchedule.ts     LP build, solve, materialise, relax
│   ├── optimizer/replay.ts            independent hour-by-hour validator
│   └── utils/num.ts                   rounding and tolerance helpers
├── scripts/
│   ├── check-optimizer.ts             offline solver suite (10 cases)
│   ├── check-edge-cases.ts            guardrail and robustness suite (19 checks)
│   └── run-public-samples.ts          end-to-end suite against a live service
├── tests/public-samples.json          the 10 public cases, compact form
├── Dockerfile                         single-stage backend build
├── render.yaml                        Render blueprint (builds backend only)
└── .env.example                       variable names only, no values
```
