import solver from "javascript-lp-solver";
import {
  Battery,
  DirectiveInterpretation,
  EffectiveConstraints,
  HourEntry,
  HourlyPlanEntry,
} from "../types";
import { buildEffectiveConstraints } from "./applyDirectives";
import { replaySchedule, ReplayReport } from "./replay";
import { round } from "../utils/num";

/** Tiny penalty on battery throughput: removes pointless cycling from degenerate optima. */
const THROUGHPUT_EPS = 1e-6;
const BIG = 1e7;

export interface SolveOutcome {
  plan: HourlyPlanEntry[];
  constraints: EffectiveConstraints;
  /** Which solver path produced the plan. */
  method: "lp" | "lp-relaxed" | "baseline";
  /** note_index values whose directive had to be dropped to reach feasibility. */
  dropped: number[];
  report: ReplayReport;
}

/* ------------------------------ LP formulation ----------------------------- */

interface LpSolution {
  feasible: boolean;
  nets: number[]; // per hour: positive = charge, negative = discharge
}

function solveLp(
  hours: HourEntry[],
  battery: Battery,
  c: EffectiveConstraints,
): LpSolution {
  const E0 = battery.initial_energy_kwh;
  const model: {
    optimize: string;
    opType: string;
    constraints: Record<string, Record<string, number>>;
    variables: Record<string, Record<string, number>>;
  } = { optimize: "cost", opType: "min", constraints: {}, variables: {} };

  for (let h = 0; h < 24; h++) {
    const bal = `bal${h}`;
    model.constraints[bal] = { equal: hours[h].demand_kwh };

    // grid import
    const grid: Record<string, number> = { cost: hours[h].tariff_bdt_per_kwh, [bal]: 1 };
    if (Number.isFinite(c.maxGrid[h])) {
      model.constraints[`gcap${h}`] = { max: c.maxGrid[h] };
      grid[`gcap${h}`] = 1;
    }
    model.variables[`g${h}`] = grid;

    // usable solar
    if (c.effectiveSolar[h] > 0) {
      model.constraints[`smax${h}`] = { max: c.effectiveSolar[h] };
      model.variables[`s${h}`] = { cost: 0, [bal]: 1, [`smax${h}`]: 1 };
    }

    // battery charge / discharge (omitted entirely when blocked by a directive)
    if (c.maxCharge[h] > 0) {
      model.constraints[`cmax${h}`] = { max: c.maxCharge[h] };
      model.variables[`c${h}`] = { cost: THROUGHPUT_EPS, [bal]: -1, [`cmax${h}`]: 1 };
    }
    if (c.maxDischarge[h] > 0) {
      model.constraints[`dmax${h}`] = { max: c.maxDischarge[h] };
      model.variables[`d${h}`] = { cost: THROUGHPUT_EPS, [bal]: 1, [`dmax${h}`]: 1 };
    }
  }

  // Battery state is expressed as a cumulative net: e[h] = E0 + sum_{k<=h}(c_k - d_k).
  for (let h = 0; h < 24; h++) {
    const name = `cum${h}`;
    if (h === 23) {
      model.constraints[name] = { equal: 0 }; // end-of-day neutrality
    } else {
      model.constraints[name] = {
        min: c.minReserve[h] - E0,
        max: battery.capacity_kwh - E0,
      };
    }
    for (let k = 0; k <= h; k++) {
      if (model.variables[`c${k}`]) model.variables[`c${k}`][name] = 1;
      if (model.variables[`d${k}`]) model.variables[`d${k}`][name] = -1;
    }
  }

  // Hour 23 still has to respect its reserve/capacity window; equal:0 covers it
  // only when E0 itself sits inside that window, which we check up front.
  if (c.minReserve[23] - E0 > 1e-9 || E0 - battery.capacity_kwh > 1e-9) {
    return { feasible: false, nets: [] };
  }

  let result: Record<string, unknown>;
  try {
    result = solver.Solve(model) as Record<string, unknown>;
  } catch {
    return { feasible: false, nets: [] };
  }

  if (!result || result.feasible !== true || result.bounded === false) {
    return { feasible: false, nets: [] };
  }

  const nets: number[] = [];
  for (let h = 0; h < 24; h++) {
    const charge = Number(result[`c${h}`] ?? 0) || 0;
    const discharge = Number(result[`d${h}`] ?? 0) || 0;
    nets.push(charge - discharge);
  }
  return { feasible: true, nets };
}

/* --------------------------- plan materialisation -------------------------- */

/**
 * Builds the final hourly plan from battery net flows.
 * Solar is maximised for the given nets (it is free), the grid is whatever the
 * energy balance still requires, so the balance equation holds by construction.
 */
function materialise(
  nets: number[],
  hours: HourEntry[],
  battery: Battery,
  c: EffectiveConstraints,
): HourlyPlanEntry[] {
  const clean = nets.map((n, h) =>
    round(Math.min(Math.max(n, -c.maxDischarge[h]), c.maxCharge[h])),
  );

  // Force exact end-of-day neutrality by absorbing any rounding residue.
  let residual = round(-clean.reduce((a, b) => a + b, 0), 6);
  if (Math.abs(residual) > 1e-9) {
    for (let h = 23; h >= 0 && Math.abs(residual) > 1e-9; h--) {
      const lo = -c.maxDischarge[h];
      const hi = c.maxCharge[h];
      const target = Math.min(Math.max(clean[h] + residual, lo), hi);
      const applied = target - clean[h];
      clean[h] = target;
      residual = residual - applied;
    }
  }

  const plan: HourlyPlanEntry[] = [];
  let energy = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    let net = clean[h];
    let need = hours[h].demand_kwh + Math.max(net, 0) - Math.max(-net, 0);
    if (need < 0) {
      // only reachable through float noise; trim the discharge instead
      net += -need;
      need = 0;
    }

    const solarUsed = round(Math.min(c.effectiveSolar[h], Math.max(need, 0)));
    const grid = round(Math.max(need - solarUsed, 0));

    const charge = net > 0 ? round(net) : 0;
    const discharge = net < 0 ? round(-net) : 0;
    energy = round(energy + charge - discharge);

    plan.push({
      hour: h,
      grid_kwh: grid,
      solar_used_kwh: solarUsed,
      battery_action: charge > 0 ? "charge" : discharge > 0 ? "discharge" : "idle",
      battery_kwh: charge > 0 ? charge : discharge > 0 ? discharge : 0,
      battery_energy_after_kwh: energy,
    });
  }

  return plan;
}

/* --------------------------------- driver ---------------------------------- */

function attempt(
  hours: HourEntry[],
  battery: Battery,
  directives: DirectiveInterpretation[],
): { plan: HourlyPlanEntry[]; constraints: EffectiveConstraints; report: ReplayReport } | null {
  const constraints = buildEffectiveConstraints(hours, battery, directives);
  const lp = solveLp(hours, battery, constraints);
  if (!lp.feasible) return null;

  const plan = materialise(lp.nets, hours, battery, constraints);
  const report = replaySchedule(plan, hours, battery, constraints);
  if (!report.valid) return null;
  return { plan, constraints, report };
}

function baselinePlan(
  hours: HourEntry[],
  battery: Battery,
  constraints: EffectiveConstraints,
): HourlyPlanEntry[] {
  return materialise(new Array(24).fill(0), hours, battery, constraints);
}

/**
 * Produces a valid 24-hour schedule of minimum grid cost.
 *
 * Correctness comes first: if a directive set is infeasible (which organizer
 * scoring scenarios will not be, but a hallucinated directive could be), the
 * solver relaxes interpreted directives one at a time rather than returning an
 * invalid plan or a 5xx.
 */
export function solveSchedule(
  hours: HourEntry[],
  battery: Battery,
  directives: DirectiveInterpretation[],
): SolveOutcome {
  const active = directives.filter((d) => d.applies && d.structured_adjustment !== null);

  const full = attempt(hours, battery, directives);
  if (full) {
    return { ...full, method: "lp", dropped: [] };
  }

  // Drop one interpreted directive at a time, then all of them.
  for (let i = active.length - 1; i >= 0; i--) {
    const subset = directives.filter((d) => d !== active[i]);
    const relaxed = attempt(hours, battery, subset);
    if (relaxed) {
      return { ...relaxed, method: "lp-relaxed", dropped: [active[i].note_index] };
    }
  }

  const none = attempt(hours, battery, []);
  if (none) {
    return {
      ...none,
      method: "lp-relaxed",
      dropped: active.map((d) => d.note_index),
    };
  }

  // Last resort: a schedule that never touches the battery. Always well formed.
  const constraints = buildEffectiveConstraints(hours, battery, directives);
  const plan = baselinePlan(hours, battery, constraints);
  return {
    plan,
    constraints,
    method: "baseline",
    dropped: active.map((d) => d.note_index),
    report: replaySchedule(plan, hours, battery, constraints),
  };
}
