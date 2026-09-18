/**
 * Canonical types for the GridWise preliminary challenge.
 * Field names follow the Problem Statement request/response schema exactly.
 */

export const DIRECTIVE_TYPES = [
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
] as const;

export type DirectiveType = (typeof DIRECTIVE_TYPES)[number];

export const BATTERY_ACTIONS = ["charge", "discharge", "idle"] as const;
export type BatteryAction = (typeof BATTERY_ACTIONS)[number];

export interface HourEntry {
  hour: number;
  demand_kwh: number;
  solar_kwh: number;
  tariff_bdt_per_kwh: number;
}

export interface Battery {
  capacity_kwh: number;
  initial_energy_kwh: number;
  minimum_energy_kwh: number;
  max_charge_kwh_per_hour: number;
  max_discharge_kwh_per_hour: number;
}

export interface ScenarioRequest {
  scenario_id: string;
  operator_notes: string[];
  hours: HourEntry[];
  battery: Battery;
}

/** structured_adjustment shapes, one per directive type. */
export interface SolarReductionAdjustment {
  hours: number[];
  factor: number;
}
export interface MinimumBatteryReserveAdjustment {
  hours: number[];
  minimum_energy_kwh: number;
}
export interface WindowAdjustment {
  hours: number[];
}
export interface MaxGridAdjustment {
  hours: number[];
  max_grid_kwh: number;
}

export type StructuredAdjustment =
  | SolarReductionAdjustment
  | MinimumBatteryReserveAdjustment
  | WindowAdjustment
  | MaxGridAdjustment
  | null;

export interface DirectiveInterpretation {
  note_index: number;
  applies: boolean;
  directive_type: DirectiveType;
  structured_adjustment: StructuredAdjustment;
  explanation: string;
}

export interface HourlyPlanEntry {
  hour: number;
  grid_kwh: number;
  solar_used_kwh: number;
  battery_action: BatteryAction;
  battery_kwh: number;
  battery_energy_after_kwh: number;
}

export interface OptimizeResponse {
  scenario_id: string;
  directive_interpretation: DirectiveInterpretation[];
  hourly_plan: HourlyPlanEntry[];
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
  plan_summary: string;
}

/** Per-hour constraint set after all valid directives have been applied. */
export interface EffectiveConstraints {
  effectiveSolar: number[]; // 24
  minReserve: number[]; // 24 (base minimum raised by reserve directives)
  maxGrid: number[]; // 24 (Infinity when uncapped)
  maxCharge: number[]; // 24 (0 inside a no_charge_window)
  maxDischarge: number[]; // 24 (0 inside a no_discharge_window)
}
