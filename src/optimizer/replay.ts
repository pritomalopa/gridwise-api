import { Battery, EffectiveConstraints, HourEntry, HourlyPlanEntry } from "../types";
import { TOL } from "../utils/num";

export interface ReplayReport {
  valid: boolean;
  violations: string[];
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
}

/**
 * Replays a finished schedule hour by hour exactly the way the judge harness
 * does, using the effective solar profile and every active directive limit.
 */
export function replaySchedule(
  plan: HourlyPlanEntry[],
  hours: HourEntry[],
  battery: Battery,
  constraints: EffectiveConstraints,
): ReplayReport {
  const violations: string[] = [];
  let energy = battery.initial_energy_kwh;
  let totalGrid = 0;
  let totalCost = 0;
  let peak = 0;

  if (plan.length !== 24) {
    violations.push(`hourly_plan has ${plan.length} entries, expected 24`);
  }

  for (let h = 0; h < Math.min(plan.length, 24); h++) {
    const entry = plan[h];
    const hour = hours[h];

    if (entry.hour !== h) violations.push(`hour ${h}: hour field mismatch`);

    for (const [name, value] of [
      ["grid_kwh", entry.grid_kwh],
      ["solar_used_kwh", entry.solar_used_kwh],
      ["battery_kwh", entry.battery_kwh],
      ["battery_energy_after_kwh", entry.battery_energy_after_kwh],
    ] as const) {
      if (!Number.isFinite(value)) violations.push(`hour ${h}: ${name} is not finite`);
      if (value < -TOL) violations.push(`hour ${h}: ${name} is negative`);
    }

    if (entry.battery_action === "idle" && Math.abs(entry.battery_kwh) > TOL) {
      violations.push(`hour ${h}: idle hour carries battery_kwh`);
    }

    if (entry.solar_used_kwh > constraints.effectiveSolar[h] + TOL) {
      violations.push(`hour ${h}: solar_used_kwh exceeds effective solar`);
    }

    if (entry.grid_kwh > constraints.maxGrid[h] + TOL) {
      violations.push(`hour ${h}: grid_kwh exceeds the active grid cap`);
    }

    const charge = entry.battery_action === "charge" ? entry.battery_kwh : 0;
    const discharge = entry.battery_action === "discharge" ? entry.battery_kwh : 0;

    if (charge > constraints.maxCharge[h] + TOL) {
      violations.push(`hour ${h}: charge exceeds the active charge limit`);
    }
    if (discharge > constraints.maxDischarge[h] + TOL) {
      violations.push(`hour ${h}: discharge exceeds the active discharge limit`);
    }

    const lhs = entry.grid_kwh + entry.solar_used_kwh + discharge;
    const rhs = hour.demand_kwh + charge;
    if (Math.abs(lhs - rhs) > TOL) {
      violations.push(`hour ${h}: energy balance off by ${(lhs - rhs).toFixed(4)}`);
    }

    energy = energy + charge - discharge;
    if (Math.abs(energy - entry.battery_energy_after_kwh) > TOL) {
      violations.push(`hour ${h}: battery_energy_after_kwh does not follow the transition`);
    }
    if (energy < constraints.minReserve[h] - TOL) {
      violations.push(`hour ${h}: battery energy below the active minimum reserve`);
    }
    if (energy > battery.capacity_kwh + TOL) {
      violations.push(`hour ${h}: battery energy above capacity`);
    }

    totalGrid += entry.grid_kwh;
    totalCost += entry.grid_kwh * hour.tariff_bdt_per_kwh;
    peak = Math.max(peak, entry.grid_kwh);
  }

  if (Math.abs(energy - battery.initial_energy_kwh) > TOL) {
    violations.push("end-of-day battery energy does not return to the initial level");
  }

  return {
    valid: violations.length === 0,
    violations,
    total_grid_kwh: totalGrid,
    total_cost_bdt: totalCost,
    peak_grid_kwh: peak,
  };
}
