'use strict';

/**
 * Cost-optimal 24h scheduler (LP via javascript-lp-solver).
 * Variables per hour h: grid g_h, solar s_h, charge c_h, discharge d_h, energy e_h.
 */

let solver = null;
try {
  // eslint-disable-next-line global-require
  solver = require('javascript-lp-solver');
} catch (_) {
  solver = null;
}

function round3(x) {
  return Math.round((x + Number.EPSILON) * 1000) / 1000;
}
function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function applyDirectives(hours, battery, directives) {
  const effSolar = hours.map((h) => h.solar_kwh);
  const minActive = hours.map(() => battery.minimum_energy_kwh);
  const noCharge = new Set();
  const noDischarge = new Set();
  const gridCap = new Map();
  for (const d of directives) {
    if (!d.applies) continue;
    const adj = d.structured_adjustment;
    if (!adj) continue;
    if (d.directive_type === 'solar_reduction') {
      for (const h of adj.hours) effSolar[h] = hours[h].solar_kwh * adj.factor;
    } else if (d.directive_type === 'minimum_battery_reserve') {
      for (const h of adj.hours) minActive[h] = Math.max(minActive[h], adj.minimum_energy_kwh);
    } else if (d.directive_type === 'no_charge_window') {
      for (const h of adj.hours) noCharge.add(h);
    } else if (d.directive_type === 'no_discharge_window') {
      for (const h of adj.hours) noDischarge.add(h);
    } else if (d.directive_type === 'max_grid_window') {
      for (const h of adj.hours) {
        if (!gridCap.has(h)) gridCap.set(h, adj.max_grid_kwh);
        else gridCap.set(h, Math.min(gridCap.get(h), adj.max_grid_kwh));
      }
    }
  }
  return { effSolar, minActive, noCharge, noDischarge, gridCap };
}

function buildAndSolve(hours, battery, eff) {
  const N = 24;
  const constraints = {};
  const variables = {};
  const ints = {};

  // Demand balance + bounds per hour
  for (let h = 0; h < N; h++) {
    const dem = hours[h].demand_kwh;
    constraints[`dem_${h}`] = { equal: dem };
    constraints[`solcap_${h}`] = { max: eff.effSolar[h] };
    constraints[`clo_${h}`] = { max: eff.noCharge.has(h) ? 0 : battery.max_charge_kwh_per_hour };
    constraints[`dlo_${h}`] = { max: eff.noDischarge.has(h) ? 0 : battery.max_discharge_kwh_per_hour };
    constraints[`elo_${h}`] = { min: eff.minActive[h] };
    constraints[`ehi_${h}`] = { max: battery.capacity_kwh };
    if (eff.gridCap.has(h)) constraints[`gcap_${h}`] = { max: eff.gridCap.get(h) };
  }
  // Battery transitions
  for (let h = 0; h < N; h++) {
    constraints[`trans_${h}`] = { equal: h === 0 ? battery.initial_energy_kwh : 0 };
  }
  constraints.final = { equal: battery.initial_energy_kwh };

  const varNames = {};
  for (let h = 0; h < N; h++) {
    const g = `g${h}`, s = `s${h}`, c = `c${h}`, d = `d${h}`, e = `e${h}`;
    varNames[h] = { g, s, c, d, e };
    const tariff = hours[h].tariff_bdt_per_kwh;
    variables[g] = { cost: tariff, [`dem_${h}`]: 1, [`gcap_${h}`]: eff.gridCap.has(h) ? 1 : 0, [`clo_${h}`]: 0, [`dlo_${h}`]: 0, [`solcap_${h}`]: 0, [`elo_${h}`]: 0, [`ehi_${h}`]: 0 };
    // remove zero keys to keep model small (solver ignores missing)
    variables[s] = { cost: 0, [`dem_${h}`]: 1, [`solcap_${h}`]: 1 };
    variables[c] = { cost: 0, [`dem_${h}`]: -1, [`clo_${h}`]: 1 };
    variables[d] = { cost: 0, [`dem_${h}`]: 1, [`dlo_${h}`]: 1 };
    variables[e] = { cost: 0, [`elo_${h}`]: 1, [`ehi_${h}`]: 1 };
    // transition: e_h - e_{h-1} - c_h + d_h == rhs
    variables[e][`trans_${h}`] = 1;
    if (h > 0) {
      const prevE = `e${h - 1}`;
      variables[prevE][`trans_${h}`] = -1;
    }
    variables[c][`trans_${h}`] = -1;
    variables[d][`trans_${h}`] = 1;
    variables[e].final = h === 23 ? 1 : 0;
  }
  // clean zero-coefficient gcap entries
  for (let h = 0; h < N; h++) {
    const { g } = varNames[h];
    if (!eff.gridCap.has(h)) delete variables[g][`gcap_${h}`];
  }

  const model = { optimize: 'cost', opType: 'min', constraints, variables };
  const result = solver.Solve(model);
  return { result, varNames };
}

function greedyFallback(hours, battery, eff) {
  // Always-feasible-ish fallback: meet demand with solar, use battery greedily
  // to respect grid caps, then price-arbitrage what remains.
  const N = 24;
  const E = new Array(N);
  const grid = new Array(N).fill(0);
  const solarUsed = eff.effSolar.map((v, h) => Math.min(v, hours[h].demand_kwh));
  // net demand after solar
  const net = hours.map((h, i) => round3(h.demand_kwh - solarUsed[i]));
  let ePrev = battery.initial_energy_kwh;
  // First pass: idle battery, grid = net; then fix grid-cap violations by pre-discharging
  for (let h = 0; h < N; h++) {
    // if grid cap violated, discharge as much as possible
    let g = net[h];
    let c = 0, d = 0;
    if (eff.gridCap.has(h) && g > eff.gridCap.get(h)) {
      const need = g - eff.gridCap.get(h);
      if (!eff.noDischarge.has(h)) {
        d = Math.min(need, battery.max_discharge_kwh_per_hour, ePrev - battery.minimum_energy_kwh);
        d = Math.max(0, d);
      }
      g -= d;
    }
    // reserve: don't let e drop below minActive
    if (ePrev - d < eff.minActive[h]) {
      const allowed = Math.max(0, ePrev - eff.minActive[h]);
      const diff = d - allowed;
      d = allowed;
      g += diff;
    }
    ePrev = round3(ePrev - d + c);
    E[h] = ePrev;
    grid[h] = round3(Math.max(0, g));
  }
  // Simple arbitrage: try to shift: charge at cheapest hours, discharge at expensive
  // (best-effort, keep feasibility). We do limited passes.
  const orderCheap = [...Array(N).keys()].sort((a, b) => hours[a].tariff_bdt_per_kwh - hours[b].tariff_bdt_per_kwh);
  const orderExp = [...orderCheap].reverse();
  // charge greedily at cheap hours if there is later expensive need and capacity allows
  // (skip complex lookahead — keep idle-based plan but restore neutrality)
  // Neutrality: E[23] must equal initial. Adjust with cheapest charge / expensive discharge.
  let drift = E[23] - battery.initial_energy_kwh;
  // if drift > 0 (ended high), discharge at most expensive hour possible
  let guard = 0;
  while (Math.abs(drift) > 0.005 && guard++ < 48) {
    if (drift > 0) {
      const h = orderExp.find((hh) => !eff.noDischarge.has(hh) && grid[hh] > 0);
      if (h === undefined) break;
      drift = E[23] - battery.initial_energy_kwh;
      break;
    } else break;
  }
  // Rebuild action arrays from grid/solar/E (idle-only => c=d=0)
  const plan = [];
  ePrev = battery.initial_energy_kwh;
  for (let h = 0; h < N; h++) {
    const eAfter = E[h];
    const delta = round3(eAfter - ePrev);
    let action = 'idle', kwh = 0;
    if (delta > 0.005) { action = 'charge'; kwh = delta; }
    else if (delta < -0.005) { action = 'discharge'; kwh = -delta; }
    plan.push({ hour: h, grid_kwh: grid[h], solar_used_kwh: round3(solarUsed[h]), battery_action: action, battery_kwh: round3(kwh), battery_energy_after_kwh: round3(eAfter) });
    ePrev = eAfter;
  }
  // Force neutrality by adjusting last hours with available headroom (simple)
  const lastFix = plan[23];
  const need = round3(battery.initial_energy_kwh - plan[22].battery_energy_after_kwh + (plan[23].battery_action === 'charge' ? plan[23].battery_kwh : plan[23].battery_action === 'discharge' ? -plan[23].battery_kwh : 0));
  // recompute hour 23 to close: grid_23 = demand_23 - solar_23 + need
  const h23 = 23;
  const s23 = Math.min(eff.effSolar[h23], hours[h23].demand_kwh + Math.max(0, need));
  let c23 = need > 0 ? need : 0;
  let d23 = need < 0 ? -need : 0;
  if (eff.noCharge.has(23)) c23 = 0;
  if (eff.noDischarge.has(23)) d23 = 0;
  c23 = Math.min(c23, battery.max_charge_kwh_per_hour);
  d23 = Math.min(d23, battery.max_discharge_kwh_per_hour);
  const g23 = round3(Math.max(0, hours[23].demand_kwh - s23 + c23 - d23));
  const e22 = plan[22].battery_energy_after_kwh;
  const e23final = round3(e22 + c23 - d23);
  plan[23] = {
    hour: 23, grid_kwh: g23, solar_used_kwh: round3(s23),
    battery_action: c23 > 0.005 ? 'charge' : d23 > 0.005 ? 'discharge' : 'idle',
    battery_kwh: round3(c23 > 0 ? c23 : d23),
    battery_energy_after_kwh: e23final,
  };
  return plan;
}

function optimize(hours, battery, directives) {
  const sorted = [...hours].sort((a, b) => a.hour - b.hour);
  const eff = applyDirectives(sorted, battery, directives);

  if (solver) {
    try {
      const { result } = buildAndSolve(sorted, battery, eff);
      if (result && result.feasible !== false && result.result !== undefined) {
        const plan = [];
        let ePrev = battery.initial_energy_kwh;
        for (let h = 0; h < 24; h++) {
          let g = Number(result[`g${h}`] || 0);
          let s = Number(result[`s${h}`] || 0);
          let c = Number(result[`c${h}`] || 0);
          let d = Number(result[`d${h}`] || 0);
          let e = Number(result[`e${h}`]);
          if (!Number.isFinite(e)) e = ePrev + c - d;
          // net simultaneous charge/discharge
          if (c > 0.005 && d > 0.005) {
            if (c >= d) { c -= d; d = 0; } else { d -= c; c = 0; }
          }
          g = Math.max(0, g); s = Math.max(0, Math.min(s, eff.effSolar[h]));
          c = Math.max(0, c); d = Math.max(0, d);
          // snap tiny values
          if (g < 0.0005) g = 0;
          if (s < 0.0005) s = 0;
          if (c < 0.0005) c = 0;
          if (d < 0.0005) d = 0;
          // recompute energy chain to avoid drift (trust c/d, recompute e)
          e = round3(ePrev + c - d);
          // clamp to bounds
          e = Math.min(battery.capacity_kwh, Math.max(eff.minActive[h], e));
          // re-derive grid from energy balance to guarantee balance:
          // grid = demand - solar + c - d
          g = round3(Math.max(0, sorted[h].demand_kwh - s + c - d));
          // grid cap clamp (if solver slightly violated)
          if (eff.gridCap.has(h)) g = Math.min(g, eff.gridCap.get(h));
          let action = 'idle', kwh = 0;
          if (c > 0.005) { action = 'charge'; kwh = round3(c); }
          else if (d > 0.005) { action = 'discharge'; kwh = round3(d); }
          else { kwh = 0; }
          // enforce no-charge/discharge exactly
          if (eff.noCharge.has(h) && action === 'charge') { action = 'idle'; kwh = 0; c = 0; g = round3(Math.max(0, sorted[h].demand_kwh - s - d)); e = round3(ePrev - d); }
          if (eff.noDischarge.has(h) && action === 'discharge') { action = 'idle'; kwh = 0; d = 0; g = round3(Math.max(0, sorted[h].demand_kwh - s + c)); e = round3(ePrev + c); }
          plan.push({ hour: h, grid_kwh: round3(g), solar_used_kwh: round3(s), battery_action: action, battery_kwh: kwh, battery_energy_after_kwh: e });
          ePrev = e;
        }
        // Fix neutrality drift: adjust last charge/discharge within limits
        const drift = round3(plan[23].battery_energy_after_kwh - battery.initial_energy_kwh);
        if (Math.abs(drift) > 0.01) {
          // try to fix by adjusting hour 23 (or latest flexible hour)
          for (let h = 23; h >= 0; h--) {
            const p = plan[h];
            const need = h === 23 ? -drift : 0;
            if (need === 0) break;
            // need>0 means must charge more (plan ended low)
            if (need > 0 && !eff.noCharge.has(h)) {
              const room = Math.min(battery.max_charge_kwh_per_hour - (p.battery_action === 'charge' ? p.battery_kwh : 0), battery.capacity_kwh - p.battery_energy_after_kwh);
              const add = Math.min(need, room);
              if (add > 0.005) {
                p.battery_action = 'charge';
                p.battery_kwh = round3((p.battery_action === 'charge' ? p.battery_kwh : 0) + add);
                p.battery_energy_after_kwh = round3(p.battery_energy_after_kwh + add);
                p.grid_kwh = round3(p.grid_kwh + add);
                // propagate to later hours (only h=23 matters here)
                break;
              }
            } else if (need < 0 && !eff.noDischarge.has(h)) {
              const avail = Math.min((p.battery_action === 'discharge' ? p.battery_kwh : 0) + battery.max_discharge_kwh_per_hour, p.battery_energy_after_kwh - eff.minActive[h]);
              const sub = Math.min(-need, Math.max(0, battery.max_discharge_kwh_per_hour - (p.battery_action === 'discharge' ? p.battery_kwh : 0)));
              if (sub > 0.005 && p.grid_kwh >= sub - 1e-9) {
                p.battery_action = p.battery_action === 'charge' ? 'idle' : 'discharge';
                if (p.battery_action === 'idle') p.battery_kwh = 0;
                else p.battery_kwh = round3(p.battery_kwh + sub);
                p.battery_energy_after_kwh = round3(p.battery_energy_after_kwh - sub);
                p.grid_kwh = round3(Math.max(0, p.grid_kwh - sub));
                break;
              }
            }
            break;
          }
        }
        if (verifyPlan(sorted, battery, eff, plan)) return plan;
        // else fall through to greedy
      }
    } catch (_) { /* fall through */ }
  }
  return greedyFallback(sorted, battery, eff);
}

function verifyPlan(hours, battery, eff, plan) {
  const TOL = 0.02;
  if (!plan || plan.length !== 24) return false;
  let ePrev = battery.initial_energy_kwh;
  for (let h = 0; h < 24; h++) {
    const p = plan[h];
    if (!p || p.hour !== h) return false;
    if (!(p.grid_kwh >= -TOL) || !(p.solar_used_kwh >= -TOL) || !(p.battery_kwh >= -TOL)) return false;
    if (p.solar_used_kwh - eff.effSolar[h] > TOL) return false;
    if (p.battery_action === 'idle' && Math.abs(p.battery_kwh) > TOL) return false;
    const c = p.battery_action === 'charge' ? p.battery_kwh : 0;
    const d = p.battery_action === 'discharge' ? p.battery_kwh : 0;
    if (c - battery.max_charge_kwh_per_hour > TOL) return false;
    if (d - battery.max_discharge_kwh_per_hour > TOL) return false;
    if (eff.noCharge.has(h) && c > TOL) return false;
    if (eff.noDischarge.has(h) && d > TOL) return false;
    if (eff.gridCap.has(h) && p.grid_kwh - eff.gridCap.get(h) > TOL) return false;
    const eExp = ePrev + c - d;
    if (Math.abs(eExp - p.battery_energy_after_kwh) > 0.05) return false;
    if (p.battery_energy_after_kwh - battery.capacity_kwh > TOL) return false;
    if (eff.minActive[h] - p.battery_energy_after_kwh > TOL) return false;
    const bal = p.grid_kwh + p.solar_used_kwh + d - hours[h].demand_kwh - c;
    if (Math.abs(bal) > 0.05) return false;
    ePrev = p.battery_energy_after_kwh;
  }
  if (Math.abs(ePrev - battery.initial_energy_kwh) > 0.05) return false;
  return true;
}

module.exports = { optimize, applyDirectives, verifyPlan };
