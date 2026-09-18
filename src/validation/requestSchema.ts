import { Battery, HourEntry, ScenarioRequest } from "../types";
import { isNum } from "../utils/num";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: ScenarioRequest;
}

const BATTERY_FIELDS: (keyof Battery)[] = [
  "capacity_kwh",
  "initial_energy_kwh",
  "minimum_energy_kwh",
  "max_charge_kwh_per_hour",
  "max_discharge_kwh_per_hour",
];

const HOUR_FIELDS: (keyof HourEntry)[] = [
  "hour",
  "demand_kwh",
  "solar_kwh",
  "tariff_bdt_per_kwh",
];

/**
 * Structural validation of POST /optimize-energy.
 * Anything that fails here is a 400 (malformed / structurally invalid request).
 */
export function validateScenarioRequest(body: unknown): ValidationResult {
  const errors: string[] = [];

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const b = body as Record<string, unknown>;

  // scenario_id
  if (typeof b.scenario_id !== "string" || b.scenario_id.length === 0) {
    errors.push("scenario_id must be a non-empty string");
  }

  // operator_notes: 1..3 non-empty strings
  if (!Array.isArray(b.operator_notes)) {
    errors.push("operator_notes must be an array");
  } else if (b.operator_notes.length < 1 || b.operator_notes.length > 3) {
    errors.push("operator_notes must contain between 1 and 3 entries");
  } else if (
    !b.operator_notes.every((n) => typeof n === "string" && n.trim().length > 0)
  ) {
    errors.push("every operator_notes entry must be a non-empty string");
  }

  // hours: exactly 24, hour 0..23 unique
  if (!Array.isArray(b.hours)) {
    errors.push("hours must be an array");
  } else if (b.hours.length !== 24) {
    errors.push("hours must contain exactly 24 entries");
  } else {
    const seen = new Set<number>();
    b.hours.forEach((h, idx) => {
      if (h === null || typeof h !== "object" || Array.isArray(h)) {
        errors.push(`hours[${idx}] must be an object`);
        return;
      }
      const entry = h as Record<string, unknown>;
      for (const field of HOUR_FIELDS) {
        if (!isNum(entry[field])) {
          errors.push(`hours[${idx}].${field} must be a finite number`);
        }
      }
      const hour = entry.hour;
      if (isNum(hour)) {
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          errors.push(`hours[${idx}].hour must be an integer from 0 to 23`);
        } else if (seen.has(hour)) {
          errors.push(`hours[${idx}].hour is duplicated`);
        } else {
          seen.add(hour);
        }
      }
      if (isNum(entry.demand_kwh) && entry.demand_kwh < 0) {
        errors.push(`hours[${idx}].demand_kwh must be non-negative`);
      }
      if (isNum(entry.solar_kwh) && entry.solar_kwh < 0) {
        errors.push(`hours[${idx}].solar_kwh must be non-negative`);
      }
    });
  }

  // battery
  if (b.battery === null || typeof b.battery !== "object" || Array.isArray(b.battery)) {
    errors.push("battery must be an object");
  } else {
    const bat = b.battery as Record<string, unknown>;
    for (const field of BATTERY_FIELDS) {
      if (!isNum(bat[field])) {
        errors.push(`battery.${field} must be a finite number`);
      } else if ((bat[field] as number) < 0) {
        errors.push(`battery.${field} must be non-negative`);
      }
    }
    if (isNum(bat.capacity_kwh) && isNum(bat.initial_energy_kwh)) {
      if (bat.initial_energy_kwh > bat.capacity_kwh) {
        errors.push("battery.initial_energy_kwh cannot exceed battery.capacity_kwh");
      }
    }
    if (isNum(bat.capacity_kwh) && isNum(bat.minimum_energy_kwh)) {
      if (bat.minimum_energy_kwh > bat.capacity_kwh) {
        errors.push("battery.minimum_energy_kwh cannot exceed battery.capacity_kwh");
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const raw = b as unknown as ScenarioRequest;
  // hours may arrive out of order; normalise to index == hour
  const sortedHours = [...raw.hours].sort((x, y) => x.hour - y.hour);

  return {
    ok: true,
    errors: [],
    value: {
      scenario_id: raw.scenario_id,
      operator_notes: raw.operator_notes.map((n) => String(n)),
      hours: sortedHours,
      battery: raw.battery,
    },
  };
}
