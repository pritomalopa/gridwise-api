import {
  Battery,
  DirectiveInterpretation,
  EffectiveConstraints,
  HourEntry,
  MaxGridAdjustment,
  MinimumBatteryReserveAdjustment,
  SolarReductionAdjustment,
  WindowAdjustment,
} from "../types";

/**
 * Section 5.3 of the Problem Statement, expressed as 24-length arrays the
 * optimizer can consume directly.
 */
export function buildEffectiveConstraints(
  hours: HourEntry[],
  battery: Battery,
  directives: DirectiveInterpretation[],
): EffectiveConstraints {
  const effectiveSolar = hours.map((h) => Math.max(0, h.solar_kwh));
  const minReserve = hours.map(() => battery.minimum_energy_kwh);
  const maxGrid = hours.map(() => Number.POSITIVE_INFINITY);
  const maxCharge = hours.map(() => battery.max_charge_kwh_per_hour);
  const maxDischarge = hours.map(() => battery.max_discharge_kwh_per_hour);

  for (const directive of directives) {
    if (!directive.applies || directive.structured_adjustment === null) continue;

    switch (directive.directive_type) {
      case "solar_reduction": {
        const adj = directive.structured_adjustment as SolarReductionAdjustment;
        for (const h of adj.hours) effectiveSolar[h] = effectiveSolar[h] * adj.factor;
        break;
      }
      case "minimum_battery_reserve": {
        const adj = directive.structured_adjustment as MinimumBatteryReserveAdjustment;
        for (const h of adj.hours) {
          minReserve[h] = Math.max(minReserve[h], adj.minimum_energy_kwh);
        }
        break;
      }
      case "no_charge_window": {
        const adj = directive.structured_adjustment as WindowAdjustment;
        for (const h of adj.hours) maxCharge[h] = 0;
        break;
      }
      case "no_discharge_window": {
        const adj = directive.structured_adjustment as WindowAdjustment;
        for (const h of adj.hours) maxDischarge[h] = 0;
        break;
      }
      case "max_grid_window": {
        const adj = directive.structured_adjustment as MaxGridAdjustment;
        for (const h of adj.hours) maxGrid[h] = Math.min(maxGrid[h], adj.max_grid_kwh);
        break;
      }
      default:
        break;
    }
  }

  return { effectiveSolar, minReserve, maxGrid, maxCharge, maxDischarge };
}
