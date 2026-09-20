'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { validateRequest } = require('./validate');
const { interpretNotes } = require('./interpret');
const { optimize } = require('./optimizer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

function summarize(directives, plan) {
  const parts = [];
  for (const d of directives) {
    if (d.directive_type === 'no_op') continue;
    const h = d.structured_adjustment.hours.join(',');
    if (d.directive_type === 'solar_reduction') parts.push(`solar x${d.structured_adjustment.factor} @[${h}]`);
    else if (d.directive_type === 'minimum_battery_reserve') parts.push(`reserve ${d.structured_adjustment.minimum_energy_kwh}kWh @[${h}]`);
    else if (d.directive_type === 'max_grid_window') parts.push(`grid<=${d.structured_adjustment.max_grid_kwh} @[${h}]`);
    else parts.push(`${d.directive_type} @[${h}]`);
  }
  const applied = parts.length ? parts.join('; ') : 'no energy directives';
  return `Applied ${applied}; battery-neutral 24h plan minimizing grid cost.`;
}

// Main endpoint
app.post('/optimize-energy', async (req, res) => {
  const v = validateRequest(req.body);
  if (!v.ok) {
    return res.status(v.status).json({ error: v.error });
  }
  try {
    const { scenario_id, operator_notes, hours, battery } = req.body;
    const sortedHours = [...hours].sort((a, b) => a.hour - b.hour);

    // 1. LLM interpretation (with guardrails + safe fallback)
    const { directives } = await interpretNotes(operator_notes, battery);

    // 2. Optimize AFTER applying directives
    const hourly_plan = optimize(sortedHours, battery, directives);

    // 3. Totals (recalculated from plan — source of truth)
    let total_grid_kwh = 0;
    let total_cost_bdt = 0;
    let peak_grid_kwh = 0;
    const tariffByHour = new Map(sortedHours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
    for (const p of hourly_plan) {
      total_grid_kwh += p.grid_kwh;
      total_cost_bdt += p.grid_kwh * tariffByHour.get(p.hour);
      if (p.grid_kwh > peak_grid_kwh) peak_grid_kwh = p.grid_kwh;
    }
    total_grid_kwh = Math.round(total_grid_kwh * 100) / 100;
    total_cost_bdt = Math.round(total_cost_bdt * 100) / 100;
    peak_grid_kwh = Math.round(peak_grid_kwh * 100) / 100;

    return res.status(200).json({
      scenario_id,
      directive_interpretation: directives,
      hourly_plan,
      total_grid_kwh,
      total_cost_bdt,
      peak_grid_kwh,
      plan_summary: summarize(directives, hourly_plan),
    });
  } catch (e) {
    // Controlled internal error — never leak stack/secrets
    return res.status(500).json({ error: 'Internal optimization error.' });
  }
});

// 404 for unknown routes
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// Malformed JSON handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed JSON.' });
  }
  return res.status(500).json({ error: 'Internal error.' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`GridWise API listening on 0.0.0.0:${PORT}`);
  });
}

module.exports = app;
