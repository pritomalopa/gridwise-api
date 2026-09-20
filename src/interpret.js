'use strict';

/**
 * Operator-note interpretation pipeline:
 *   LLM (OpenAI-compatible / Gemini / Ollama) -> deterministic guardrails
 *   Fallback: robust heuristic parser (offline-safe, paraphrase tolerant)
 *
 * The LLM is ALWAYS attempted first when any provider is configured, and its
 * guardrailed output is what drives the optimizer. The heuristic is only a
 * safe-failure fallback (LLM missing / timeout / invalid JSON).
 */

const ALLOWED_TYPES = new Set([
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op',
]);

function llmConfig() {
  const env = process.env;
  const providers = [];
  if (env.OPENAI_API_KEY) {
    providers.push({
      kind: 'openai',
      baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
    });
  }
  if (env.GEMINI_API_KEY) {
    providers.push({
      kind: 'gemini',
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || 'gemini-2.0-flash',
    });
  }
  if (env.OLLAMA_BASE_URL) {
    providers.push({
      kind: 'ollama',
      baseUrl: env.OLLAMA_BASE_URL.replace(/\/$/, ''),
      model: env.OLLAMA_MODEL || 'llama3.1:8b',
    });
  }
  return providers;
}

function buildPrompt(notes, battery) {
  const lines = notes.map((n, i) => `NOTE ${i}: """${n}"""`).join('\n');
  return `You interpret campus operator notes into STRICT structured energy directives.

Battery context: capacity_kwh=${battery.capacity_kwh}, minimum_energy_kwh=${battery.minimum_energy_kwh}.

Allowed directive_type values (exactly these):
- solar_reduction: usable solar drops during hours. structured_adjustment={"hours":[...],"factor":number}. factor = FRACTION REMAINING (0..1). "80% reduction" -> 0.2. "treated as 25% of forecast" -> 0.25. "about half" -> 0.5.
- minimum_battery_reserve: keep battery_energy_after_kwh >= minimum_energy_kwh for hours. structured_adjustment={"hours":[...],"minimum_energy_kwh":number}. "50% of capacity" with capacity ${battery.capacity_kwh} -> ${battery.capacity_kwh / 2}. Resolve percentages using the capacity above.
- no_charge_window: battery charging banned. structured_adjustment={"hours":[...]}.
- no_discharge_window: battery discharging banned. structured_adjustment={"hours":[...]}.
- max_grid_window: grid import capped per hour. structured_adjustment={"hours":[...],"max_grid_kwh":number}.
- no_op: note does NOT affect the 24h energy schedule (cafeteria menu, library hours, registration deadlines, club notices, seminar bookings, anything without energy effect). applies=false, structured_adjustment=null.

TIME RULE (critical): whole hours 0-23, start-INCLUSIVE end-EXCLUSIVE. "1 PM to 3 PM" -> [13,14]. "noon until 2 PM" -> [12,13]. "2 AM until 5 AM" -> [2,3,4]. "6 PM until 9 PM" -> [18,19,20]. "6 PM until 10 PM" -> [18,19,20,21]. "11 AM until 1 PM" -> [11,12]. "13:00 to 15:00" -> [13,14]. "10 AM until noon" -> [10,11] (noon=12). "midnight"=0. Hours sorted ascending, unique integers 0-23.

CHARGE vs DISCHARGE: "do not charge / charging unavailable / charger isolated / charging circuit unavailable" -> no_charge_window. "do not discharge / must not discharge / discharge disabled" -> no_discharge_window. Never confuse them.

GRID CAP: mentions of "grid import/import/intake must not exceed X kWh / capped at X / feeder / transformer / substation limit" -> max_grid_window with that X.

RESERVE: "keep at least X kWh / reserve / emergency" -> minimum_battery_reserve with that X.

Return ONLY a JSON array with EXACTLY ${notes.length} entries, one per note in order:
[{"note_index":0,"applies":true,"directive_type":"solar_reduction","structured_adjustment":{"hours":[13,14],"factor":0.2},"explanation":"..."}, ...]
For no_op: {"note_index":i,"applies":false,"directive_type":"no_op","structured_adjustment":null,"explanation":"..."}.
No markdown, no code fences, no extra text.

Notes:
${lines}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAICompatible(p, prompt, timeoutMs) {
  const res = await fetchWithTimeout(
    `${p.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify({
        model: p.model,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You output only valid JSON. No markdown.' },
          { role: 'user', content: prompt },
        ],
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`openai http ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('openai empty response');
  return text;
}

async function callGemini(p, prompt, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationConfig: { temperature: 0, maxOutputTokens: 1200, responseMimeType: 'application/json' },
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`gemini http ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('');
  if (!text) throw new Error('gemini empty response');
  return text;
}

async function callOllama(p, prompt, timeoutMs) {
  const res = await fetchWithTimeout(
    `${p.baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: 'You output only valid JSON. No markdown.' },
          { role: 'user', content: prompt },
        ],
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`ollama http ${res.status}`);
  const data = await res.json();
  const text = data?.message?.content;
  if (!text) throw new Error('ollama empty response');
  return text;
}

function extractJsonArray(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  // Try direct parse
  try {
    const v = JSON.parse(cleaned);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.directives)) return v.directives;
    if (v && Array.isArray(v.interpretations)) return v.interpretations;
  } catch (_) { /* fall through */ }
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      const v = JSON.parse(slice);
      if (Array.isArray(v)) return v;
    } catch (_) { /* ignore */ }
  }
  throw new Error('no JSON array in LLM output');
}

// ---------------- deterministic guardrails ----------------

function normHours(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const h of raw) {
    const n = typeof h === 'number' ? h : parseInt(h, 10);
    if (!Number.isInteger(n) || n < 0 || n > 23 || seen.has(n)) return null;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  if (out.length === 0) return null;
  return out;
}

function guardrailEntry(raw, noteCount, battery) {
  if (!raw || typeof raw !== 'object') return null;
  const note_index = raw.note_index;
  if (!Number.isInteger(note_index) || note_index < 0 || note_index >= noteCount) return null;
  const directive_type = raw.directive_type;
  if (!ALLOWED_TYPES.has(directive_type)) return null;
  const applies = raw.applies;
  const adj = raw.structured_adjustment ?? null;
  const explanation = typeof raw.explanation === 'string' && raw.explanation.trim() !== ''
    ? raw.explanation.slice(0, 300)
    : defaultExplanation(directive_type);

  if (directive_type === 'no_op') {
    if (applies !== false || adj !== null) return null;
    return { note_index, applies: false, directive_type, structured_adjustment: null, explanation };
  }
  if (applies !== true) return null;
  if (!adj || typeof adj !== 'object') return null;
  const hours = normHours(adj.hours);
  if (!hours) return null;

  if (directive_type === 'solar_reduction') {
    const f = Number(adj.factor);
    if (!Number.isFinite(f) || f < 0 || f > 1) return null;
    return { note_index, applies: true, directive_type, structured_adjustment: { hours, factor: round2(f) }, explanation };
  }
  if (directive_type === 'minimum_battery_reserve') {
    const v = Number(adj.minimum_energy_kwh);
    if (!Number.isFinite(v) || v < 0 || v > battery.capacity_kwh) return null;
    return { note_index, applies: true, directive_type, structured_adjustment: { hours, minimum_energy_kwh: round2(v) }, explanation };
  }
  if (directive_type === 'no_charge_window' || directive_type === 'no_discharge_window') {
    const keys = Object.keys(adj);
    if (keys.length !== 1 || keys[0] !== 'hours') return null;
    return { note_index, applies: true, directive_type, structured_adjustment: { hours }, explanation };
  }
  if (directive_type === 'max_grid_window') {
    const v = Number(adj.max_grid_kwh);
    if (!Number.isFinite(v) || v < 0) return null;
    return { note_index, applies: true, directive_type, structured_adjustment: { hours, max_grid_kwh: round2(v) }, explanation };
  }
  return null;
}

function defaultExplanation(t) {
  const m = {
    solar_reduction: 'Solar availability is reduced during the stated window.',
    minimum_battery_reserve: 'Battery reserve must be maintained during the stated window.',
    no_charge_window: 'Battery charging is unavailable during the stated window.',
    no_discharge_window: 'Battery discharge is unavailable during the stated window.',
    max_grid_window: 'Grid import is capped during the stated window.',
    no_op: 'This note does not affect the 24-hour energy schedule.',
  };
  return m[t] || 'Interpreted operator note.';
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// ---------------- heuristic fallback parser ----------------
// Paraphrase-tolerant keyword + time/number extraction. Used ONLY when the
// LLM is unavailable or its output fails guardrails.

const WORD_HOUR = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function wordToHour(w) {
  return WORD_HOUR[w.toLowerCase()] ?? null;
}

function hourTokenToInt(tok) {
  const t = tok.toLowerCase().trim();
  if (t === 'noon') return 12;
  if (t === 'midnight') return 0;
  if (WORD_HOUR[t] !== undefined) return WORD_HOUR[t]; // bare word, resolved later
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3];
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else {
    if (h < 0 || h > 23) return null;
  }
  return h;
}

function extractWindow(note) {
  const text = note.toLowerCase();
  const isSolar = /solar|pv\b|photovoltaic|panel|rooftop|inverter/.test(text);

  // 1) Shared-suffix numeric range: "1-3 pm", "1 to 3 pm", "1–3pm", "11-2 pm"
  let m = text.match(/\b(\d{1,2})\s*(?:-|–|—|to|until|till|through|thru)\s*(\d{1,2})\s*(am|pm)\b/);
  if (m) {
    const suf = m[3];
    const s = hourTokenToInt(`${m[1]} ${suf}`);
    const e = hourTokenToInt(`${m[2]} ${suf}`);
    if (s !== null && e !== null) {
      const r = expandRange(s, e);
      if (r) return r;
    }
  }
  // 2) Word-number range: "one until three", "eleven until one pm", "ten until noon"
  m = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\s*(?:-|–|—|to|until|till|through|thru)\s*\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight)\b(?:\s*(am|pm))?/);
  if (m) {
    let s = wordToHour(m[1]);
    let eTok = m[2];
    let e = eTok === 'noon' ? 12 : eTok === 'midnight' ? 0 : wordToHour(eTok);
    const suf = m[3];
    if (s !== null && e !== null) {
      if (suf === 'pm' && s < 12) s += 12;
      if (suf === 'am' && s === 12) s = 0;
      if (suf === 'pm' && e < 12) e += 12;
      if (suf === 'am' && e === 12) e = 0;
      // No suffix: infer PM for daytime energy windows (solar notes say "one until three" = 13-15)
      if (!suf && isSolar && s >= 1 && s <= 11 && e >= 1 && e <= 12) {
        s += 12;
        e = e <= 12 ? (e === 12 ? 12 : e + 12) : e;
      } else if (!suf && s >= 1 && s <= 12 && e >= 1 && e <= 12 && e <= s) {
        // e.g. "eleven until one" (am->pm wrap): treat end as pm
        e += 12;
      }
      const r = expandRange(s, e);
      if (r) return r;
    }
  }
  // 3) "between X and Y" with words or digits
  m = text.match(/\bbetween\b\s+([^\n,;]{1,30}?)\s+and\s+([^\n,;]{1,30}?)(?:\.|,|;|because|while|during|$)/);
  if (m) {
    const s = parseSingleTime(m[1], isSolar);
    const e = parseSingleTime(m[2], isSolar);
    if (s !== null && e !== null) {
      const r = expandRange(s, e);
      if (r) return r;
    }
  }

  // 4) find all time tokens with positions (fallback)
  const timeRe = /(\bmidnight\b|\bnoon\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b)/g;
  const tokens = [];
  let mm;
  while ((mm = timeRe.exec(text)) !== null) {
    const v = hourTokenToInt(mm[1]);
    if (v !== null && !(WORD_HOUR[mm[1].toLowerCase()] !== undefined)) tokens.push({ value: v, index: mm.index });
    else if (v !== null && /\bam\b|\bpm\b/.test(mm[0])) tokens.push({ value: v, index: mm.index });
  }
  if (tokens.length >= 2) {
    // range keywords between first two times? take first pair linked by until/to/-/between/and
    const start = tokens[0].value;
    const end = tokens[1].value;
    return expandRange(start, end);
  }
  if (tokens.length === 1) return [tokens[0].value];
  // 5) bare "noon" alone
  if (/\bnoon\b/.test(text) && /\buntil\b|\bto\b|\btill\b/.test(text)) {
    // e.g. "10 AM until noon" — first token missed? try digit+noon pair
    const dm = text.match(/\b(\d{1,2})\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*noon\b/);
    if (dm) {
      const s = hourTokenToInt(`${dm[1]} ${dm[2] || (isSolar ? 'am' : 'am')}`);
      if (s !== null) return expandRange(s, 12);
    }
  }
  return null;
}

function parseSingleTime(frag, isSolar) {
  const t = frag.toLowerCase().trim();
  let m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (m) return hourTokenToInt(`${m[1]}${m[2] ? ':' + m[2] : ''} ${m[3]}`);
  m = t.match(/(\d{1,2}):(\d{2})/);
  if (m) return hourTokenToInt(`${m[1]}:${m[2]}`);
  m = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/);
  if (m) {
    let h = wordToHour(m[1]);
    if (isSolar && h >= 1 && h <= 11) h += 12; // daytime inference
    return h;
  }
  if (/\bnoon\b/.test(t)) return 12;
  if (/\bmidnight\b/.test(t)) return 0;
  m = t.match(/\b(\d{1,2})\b/);
  if (m) {
    let h = parseInt(m[1], 10);
    if (isSolar && h >= 1 && h <= 6) h += 12;
    return h;
  }
  return null;
}

function expandRange(start, end) {
  let e = end;
  if (e <= start) {
    // e.g. "11 AM until 1 PM": 11 -> 13, fine (end > start). Only wrap if truly next-day.
    if (e <= start && e < 12 && start > 12) { /* already handled by ampm */ }
    else if (e <= start) return null;
  }
  const out = [];
  for (let h = start; h < e; h++) {
    if (h < 0 || h > 23) return null;
    out.push(h);
  }
  return out.length ? out : null;
}

const WORD_NUM = {
  half: 0.5, quarter: 0.25, third: 1 / 3, fifth: 0.2,
  'one-fifth': 0.2, 'one fifth': 0.2, 'one-quarter': 0.25, 'one quarter': 0.25,
};

function extractFactor(note) {
  const t = note.toLowerCase();
  // "X% reduction/decrease/cut" -> 1 - X/100
  let m = t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:reduction|reduc|decrease|drop|cut|less|curtail)/);
  if (m) return clamp01(1 - parseFloat(m[1]) / 100);
  // "drop to/about X%" or "treated as X%" or "X% of (the )?forecast/output" -> X/100
  m = t.match(/(?:drop|fall|treated|leav(?:e|es)|about|roughly|approximately|around|only|down to|to about|at about)\D{0,30}?(\d+(?:\.\d+)?)\s*%/);
  if (m) return clamp01(parseFloat(m[1]) / 100);
  m = t.match(/(\d+(?:\.\d+)?)\s*%\s*of/);
  if (m) return clamp01(parseFloat(m[1]) / 100);
  // generic "X%" near solar words
  if (/solar|pv|photovoltaic|panel|rooftop|inverter/.test(t)) {
    m = t.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) {
      const v = parseFloat(m[1]);
      // if sentence says reduction -> remaining, else remaining
      if (/reduction|reduc|decrease|drop|cut/.test(t)) return clamp01(1 - v / 100);
      return clamp01(v / 100);
    }
  }
  for (const [w, v] of Object.entries(WORD_NUM)) {
    if (t.includes(w)) {
      if (/reduction|reduc|drop|cut|decrease/.test(t) && (w === 'fifth' || w.includes('fifth'))) return 0.2;
      return v;
    }
  }
  if (/\bhalf\b/.test(t)) return 0.5;
  return null;
}

function extractKwh(note) {
  const m = note.toLowerCase().match(/(\d+(?:\.\d+)?)\s*kwh/);
  return m ? parseFloat(m[1]) : null;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return null;
  return Math.min(1, Math.max(0, Math.round(x * 1000) / 1000));
}

function heuristicOne(note, index, battery) {
  const t = note.toLowerCase();
  const hasSolar = /solar|pv\b|photovoltaic|panel|rooftop|inverter|cloud|generation|production/.test(t);
  const hasCharge = /charg/.test(t);
  const hasDischarge = /discharg/.test(t);
  const hasBattery = /batter/.test(t);
  const hasGrid = /grid|import|intake|feeder|transformer|substation/.test(t);
  const hasReserve = /reserve|keep at least|keep\b.*\bkwh|remain in the battery|stored in the battery|emergency|data center requires/.test(t);
  const hours = extractWindow(note);

  // 1. solar reduction
  if (hasSolar && (/reduc|drop|fall|leav|%|half|quarter|fifth|usable|forecast|output|cloud|wash|clean|inspect|maintenance|inverter|cover/.test(t))) {
    const f = extractFactor(note);
    if (f !== null && hours) {
      return { note_index: index, applies: true, directive_type: 'solar_reduction', structured_adjustment: { hours, factor: f }, explanation: 'Solar availability is reduced during the stated window.' };
    }
  }
  // 2. reserve (check before charge/discharge since reserve notes also mention battery)
  if (hasReserve && (hasBattery || /kwh/.test(t))) {
    let val = extractKwh(note);
    const pct = t.match(/(\d+(?:\.\d+)?)\s*%\s*of[^.]*?(?:batter|capacity)/);
    if (pct) val = (parseFloat(pct[1]) / 100) * battery.capacity_kwh;
    else if (val === null) {
      const pct2 = t.match(/(\d+(?:\.\d+)?)\s*%/);
      if (pct2 && /capac|batter/.test(t)) val = (parseFloat(pct2[1]) / 100) * battery.capacity_kwh;
    }
    if (val !== null && Number.isFinite(val) && hours) {
      val = Math.min(val, battery.capacity_kwh);
      return { note_index: index, applies: true, directive_type: 'minimum_battery_reserve', structured_adjustment: { hours, minimum_energy_kwh: round2(val) }, explanation: 'Battery reserve must be maintained during the stated window.' };
    }
  }
  // 3. max grid cap
  if (hasGrid && (/exceed|cap|limit|at or below|stay at|must not|constrained|temporary/.test(t) || /kwh/.test(t))) {
    const val = extractKwh(note);
    if (val !== null && hours) {
      return { note_index: index, applies: true, directive_type: 'max_grid_window', structured_adjustment: { hours, max_grid_kwh: round2(val) }, explanation: 'Grid import is capped during the stated window.' };
    }
  }
  // 4. no_charge / no_discharge — disambiguate carefully
  const banSignal = /not charge|no charg|without charg|charging.{0,40}unavailable|charging.{0,40}disabled|charger.{0,40}inspect|charger.{0,40}isolat|charging circuit|do not charge|must not charge|cannot charge|disabled from|unavailable from|not\b.{0,20}\bcharge|no\b.{0,20}\bcharg/.test(t)
    || /do not\b.{0,30}\bcharge|disabled\b.{0,30}\bcharg|unavailable\b.{0,30}\bcharg/.test(t);
  const disSignal = /not discharge|no discharge|without discharg|discharg.{0,40}unavailable|discharg.{0,40}disabled|do not discharge|must not discharge|not\b.{0,20}\bdischarge|discharge.{0,20}disabled|do not\b.{0,30}\bdischarge/.test(t);

  if (hasDischarge && disSignal && hours) {
    return { note_index: index, applies: true, directive_type: 'no_discharge_window', structured_adjustment: { hours }, explanation: 'Battery discharge is unavailable during the stated window.' };
  }
  if (hasCharge && !hasDischarge && banSignal && hours) {
    return { note_index: index, applies: true, directive_type: 'no_charge_window', structured_adjustment: { hours }, explanation: 'Battery charging is unavailable during the stated window.' };
  }
  // generic battery ban without explicit discharge word
  if (hasBattery && banSignal && hours && !hasDischarge) {
    return { note_index: index, applies: true, directive_type: 'no_charge_window', structured_adjustment: { hours }, explanation: 'Battery charging is unavailable during the stated window.' };
  }
  // 5. distractor -> no_op
  return { note_index: index, applies: false, directive_type: 'no_op', structured_adjustment: null, explanation: 'This note does not affect the 24-hour energy schedule.' };
}

function heuristicInterpret(notes, battery) {
  return notes.map((n, i) => heuristicOne(String(n), i, battery));
}

// ---------------- main entry ----------------

async function interpretNotes(notes, battery) {
  const providers = llmConfig();
  let llmUsed = 'heuristic';
  let llmRaw = null;

  if (providers.length > 0) {
    const prompt = buildPrompt(notes, battery);
    const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '9000', 10);
    const maxRetries = Math.max(0, parseInt(process.env.LLM_MAX_RETRIES || '1', 10));
    for (const p of providers) {
      let text = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (p.kind === 'gemini') text = await callGemini(p, prompt, timeoutMs);
          else if (p.kind === 'ollama') text = await callOllama(p, prompt, timeoutMs);
          else text = await callOpenAICompatible(p, prompt, timeoutMs);
          break;
        } catch (e) {
          llmRaw = `provider ${p.kind} attempt ${attempt + 1} error: ${e.message}`;
          text = null;
          if (attempt === maxRetries) break;
        }
      }
      if (!text) continue; // try next provider
      try {
        const arr = extractJsonArray(text);
        // guardrail every entry
        const guarded = [];
        let allOk = true;
        const seenIdx = new Set();
        for (const raw of arr) {
          const g = guardrailEntry(raw, notes.length, battery);
          if (!g || seenIdx.has(g.note_index)) { allOk = false; break; }
          seenIdx.add(g.note_index);
          guarded.push(g);
        }
        if (allOk && guarded.length === notes.length) {
          guarded.sort((a, b) => a.note_index - b.note_index);
          // ensure 0..N-1 coverage
          let cover = true;
          for (let i = 0; i < notes.length; i++) if (guarded[i].note_index !== i) cover = false;
          if (cover) {
            llmUsed = p.kind + ':' + p.model;
            return { directives: guarded, llmUsed, llmRaw: text.slice(0, 2000) };
          }
        }
        llmRaw = String(text).slice(0, 2000);
      } catch (e) {
        llmRaw = `provider ${p.kind} error: ${e.message}`;
        // try next provider
      }
    }
  }

  // Safe failure: heuristic fallback (deterministic, offline)
  const fallback = heuristicInterpret(notes, battery);
  // guardrail fallback too (should always pass)
  const guarded = fallback.map((d) => guardrailEntry(d, notes.length, battery)).filter(Boolean);
  if (guarded.length === notes.length) {
    guarded.sort((a, b) => a.note_index - b.note_index);
    return { directives: guarded, llmUsed, llmRaw };
  }
  // absolute last resort: all no_op
  return {
    directives: notes.map((_, i) => ({ note_index: i, applies: false, directive_type: 'no_op', structured_adjustment: null, explanation: 'This note does not affect the 24-hour energy schedule.' })),
    llmUsed,
    llmRaw,
  };
}

module.exports = { interpretNotes, guardrailEntry, heuristicInterpret, ALLOWED_TYPES };
