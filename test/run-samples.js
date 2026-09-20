'use strict';
/* Test harness: replays all 10 public samples against local or live API. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TOL = 0.011;

async function post(scenario) {
  const res = await fetch(`${BASE}/optimize-energy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function eqArr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function checkInterpretation(got, exp) {
  const errs = [];
  if (!Array.isArray(got) || got.length !== exp.length) {
    return [`directive count: got ${Array.isArray(got) ? got.length : '?'} expected ${exp.length}`];
  }
  for (let i = 0; i < exp.length; i++) {
    const g = got[i], e = exp[i];
    if (g.note_index !== e.note_index) errs.push(`note ${i}: note_index ${g.note_index} != ${e.note_index}`);
    if (g.applies !== e.applies) errs.push(`note ${i}: applies ${g.applies} != ${e.applies}`);
    if (g.directive_type !== e.directive_type) errs.push(`note ${i}: type ${g.directive_type} != ${e.directive_type}`);
    const ga = g.structured_adjustment, ea = e.structured_adjustment;
    if (ea === null) {
      if (ga !== null) errs.push(`note ${i}: adjustment should be null`);
    } else {
      if (!ga) { errs.push(`note ${i}: missing adjustment`); continue; }
      if (!eqArr(ga.hours, ea.hours)) errs.push(`note ${i}: hours [${ga.hours}] != [${ea.hours}]`);
      for (const k of ['factor', 'minimum_energy_kwh', 'max_grid_kwh']) {
        if (ea[k] !== undefined && Math.abs((ga[k] ?? NaN) - ea[k]) > 0.011) {
          errs.push(`note ${i}: ${k} ${ga[k]} != ${e[k] ?? ea[k]}`);
        }
      }
    }
  }
  return errs;
}

function replay(input, out) {
  const errs = [];
  const hours = [...input.hours].sort((a, b) => a.hour - b.hour);
  const effSolar = hours.map((h) => h.solar_kwh);
  const minActive = hours.map(() => input.battery.minimum_energy_kwh);
  const noCh = new Set(), noDi = new Set(), cap = new Map();
  // ground-truth directives from expected_output? No — use RETURNED interpretation applied?
  // For validity we check against returned directives (downstream application) AND report.
  for (const d of out.directive_interpretation || []) {
    if (!d.applies) continue;
    const a = d.structured_adjustment || {};
    if (d.directive_type === 'solar_reduction') for (const h of a.hours || []) effSolar[h] *= a.factor;
    if (d.directive_type === 'minimum_battery_reserve') for (const h of a.hours || []) minActive[h] = Math.max(minActive[h], a.minimum_energy_kwh);
    if (d.directive_type === 'no_charge_window') for (const h of a.hours || []) noCh.add(h);
    if (d.directive_type === 'no_discharge_window') for (const h of a.hours || []) noDi.add(h);
    if (d.directive_type === 'max_grid_window') for (const h of a.hours || []) cap.set(h, a.max_grid_kwh);
  }
  const plan = out.hourly_plan || [];
  if (plan.length !== 24) errs.push(`hourly_plan length ${plan.length}`);
  let ePrev = input.battery.initial_energy_kwh;
  let tg = 0, tc = 0, pk = 0;
  const seen = new Set();
  for (const p of plan) {
    seen.add(p.hour);
    tg += p.grid_kwh; tc += p.grid_kwh * hours[p.hour].tariff_bdt_per_kwh; pk = Math.max(pk, p.grid_kwh);
    if (p.solar_used_kwh - effSolar[p.hour] > TOL) errs.push(`h${p.hour}: solar ${p.solar_used_kwh} > eff ${effSolar[p.hour].toFixed(2)}`);
    const c = p.battery_action === 'charge' ? p.battery_kwh : 0;
    const d = p.battery_action === 'discharge' ? p.battery_kwh : 0;
    if (p.battery_action === 'idle' && Math.abs(p.battery_kwh) > TOL) errs.push(`h${p.hour}: idle kwh!=0`);
    if (c - input.battery.max_charge_kwh_per_hour > TOL) errs.push(`h${p.hour}: charge limit`);
    if (d - input.battery.max_discharge_kwh_per_hour > TOL) errs.push(`h${p.hour}: discharge limit`);
    if (noCh.has(p.hour) && c > TOL) errs.push(`h${p.hour}: charge banned`);
    if (noDi.has(p.hour) && d > TOL) errs.push(`h${p.hour}: discharge banned`);
    if (cap.has(p.hour) && p.grid_kwh - cap.get(p.hour) > TOL) errs.push(`h${p.hour}: grid cap`);
    const eExp = ePrev + c - d;
    if (Math.abs(eExp - p.battery_energy_after_kwh) > 0.05) errs.push(`h${p.hour}: battery transition ${eExp.toFixed(2)} vs ${p.battery_energy_after_kwh}`);
    if (p.battery_energy_after_kwh - input.battery.capacity_kwh > TOL) errs.push(`h${p.hour}: over capacity`);
    if (minActive[p.hour] - p.battery_energy_after_kwh > TOL) errs.push(`h${p.hour}: below reserve ${p.battery_energy_after_kwh} < ${minActive[p.hour]}`);
    const bal = p.grid_kwh + p.solar_used_kwh + d - hours[p.hour].demand_kwh - c;
    if (Math.abs(bal) > 0.05) errs.push(`h${p.hour}: balance ${bal.toFixed(2)}`);
    ePrev = p.battery_energy_after_kwh;
  }
  if (seen.size !== 24) errs.push('hours not unique 0-23');
  if (Math.abs(ePrev - input.battery.initial_energy_kwh) > 0.05) errs.push(`neutrality ${ePrev} != ${input.battery.initial_energy_kwh}`);
  if (Math.abs(tg - (out.total_grid_kwh || 0)) > 0.05) errs.push(`total_grid ${tg.toFixed(2)} vs ${out.total_grid_kwh}`);
  if (Math.abs(tc - (out.total_cost_bdt || 0)) > 1.0) errs.push(`total_cost ${tc.toFixed(2)} vs ${out.total_cost_bdt}`);
  if (Math.abs(pk - (out.peak_grid_kwh || 0)) > 0.05) errs.push(`peak ${pk} vs ${out.peak_grid_kwh}`);
  return { errs, cost: tc };
}

async function main() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.md'), 'utf8');
  const pack = JSON.parse(raw);
  // health
  try {
    const h = await fetch(`${BASE}/health`).then((r) => r.json());
    console.log('health:', JSON.stringify(h));
  } catch (e) {
    console.log('health FAILED:', e.message);
    process.exit(1);
  }
  let passInterp = 0, passValid = 0;
  for (const c of pack.cases) {
    const { status, body } = await post(c.input);
    if (status !== 200) {
      console.log(`${c.id}: HTTP ${status} ${JSON.stringify(body).slice(0, 200)} FAIL`);
      continue;
    }
    const ie = checkInterpretation(body.directive_interpretation, c.expected_output.directive_interpretation);
    const { errs, cost } = replay(c.input, body);
    const refCost = c.expected_output.total_cost_bdt;
    const ratio = refCost > 0 ? (refCost / cost) : 1;
    const iOk = ie.length === 0, vOk = errs.length === 0;
    if (iOk) passInterp++;
    if (vOk) passValid++;
    console.log(`${c.id}: interp ${iOk ? 'PASS' : 'FAIL'} | valid ${vOk ? 'PASS' : 'FAIL'} | cost ${cost.toFixed(0)} vs ref ${refCost} (ratio ${ratio.toFixed(3)})`);
    if (!iOk) console.log('   interp:', ie.slice(0, 4).join(' ; '));
    if (!vOk) console.log('   replay:', errs.slice(0, 4).join(' ; '));
  }
  console.log(`\nSummary: interpretation ${passInterp}/${pack.cases.length}, validity ${passValid}/${pack.cases.length}`);
  if (passInterp < pack.cases.length || passValid < pack.cases.length) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
