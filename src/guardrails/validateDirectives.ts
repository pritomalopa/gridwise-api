import {
  DirectiveInterpretation,
  DirectiveType,
  DIRECTIVE_TYPES,
  StructuredAdjustment,
} from "../types";
import { isNum, round } from "../utils/num";

const ALLOWED = new Set<string>(DIRECTIVE_TYPES);

const NO_OP_EXPLANATION = "This note does not affect today's 24-hour energy schedule.";
const REJECTED_EXPLANATION =
  "The structured directive failed deterministic validation, so it was treated as no operation.";

function noOp(note_index: number, explanation: string): DirectiveInterpretation {
  return {
    note_index,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation,
  };
}

function shortText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

/**
 * Normalise an hours array: keep whole integers in 0..23, drop duplicates,
 * sort ascending. Returns null when nothing usable survives.
 */
function normaliseHours(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const kept: number[] = [];
  for (const entry of value) {
    const n = typeof entry === "string" ? Number(entry) : entry;
    if (!isNum(n)) return null; // a non-numeric hour means the object is untrustworthy
    if (!Number.isInteger(n)) return null;
    if (n < 0 || n > 23) return null;
    if (!kept.includes(n)) kept.push(n);
  }
  if (kept.length === 0) return null;
  kept.sort((a, b) => a - b);
  return kept;
}

function pickEntry(raw: unknown[], noteIndex: number): Record<string, unknown> | null {
  // Preferred: the model tagged the entry with the right note_index.
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const idx = typeof obj.note_index === "string" ? Number(obj.note_index) : obj.note_index;
      if (isNum(idx) && idx === noteIndex) return obj;
    }
  }
  // Fallback: positional match when note_index is missing entirely.
  const positional = raw[noteIndex];
  if (positional && typeof positional === "object" && !Array.isArray(positional)) {
    const obj = positional as Record<string, unknown>;
    if (obj.note_index === undefined) return obj;
  }
  return null;
}

export interface GuardrailOutcome {
  directives: DirectiveInterpretation[];
  /** Non-sensitive notes about what the guardrails had to fix, for server logs only. */
  repairs: string[];
  /**
   * Note indices where the model either returned nothing or produced a directive
   * that failed validation. A note the model deliberately marked no_op is NOT
   * listed here.
   */
  rejected: number[];
}

/**
 * Turn untrusted model output into exactly `noteCount` valid interpretation
 * entries in note_index order. Nothing outside the supported directive set can
 * ever reach the optimizer.
 */
export function validateAndRepair(
  raw: unknown[],
  noteCount: number,
  batteryCapacityKwh: number,
): GuardrailOutcome {
  const directives: DirectiveInterpretation[] = [];
  const repairs: string[] = [];
  const rejected: number[] = [];
  const list = Array.isArray(raw) ? raw : [];

  for (let i = 0; i < noteCount; i++) {
    const entry = pickEntry(list, i);
    if (!entry) {
      repairs.push(`note ${i}: no interpretation returned`);
      rejected.push(i);
      directives.push(noOp(i, NO_OP_EXPLANATION));
      continue;
    }

    const rawType = typeof entry.directive_type === "string" ? entry.directive_type.trim() : "";
    const explanation = shortText(entry.explanation, NO_OP_EXPLANATION);

    if (!ALLOWED.has(rawType)) {
      repairs.push(`note ${i}: unsupported directive_type`);
      rejected.push(i);
      directives.push(noOp(i, NO_OP_EXPLANATION));
      continue;
    }

    const type = rawType as DirectiveType;

    if (type === "no_op") {
      directives.push(noOp(i, explanation));
      continue;
    }

    const adjustment = entry.structured_adjustment;
    if (!adjustment || typeof adjustment !== "object" || Array.isArray(adjustment)) {
      repairs.push(`note ${i}: missing structured_adjustment for ${type}`);
      rejected.push(i);
      directives.push(noOp(i, REJECTED_EXPLANATION));
      continue;
    }
    const adj = adjustment as Record<string, unknown>;

    const hours = normaliseHours(adj.hours);
    if (!hours) {
      repairs.push(`note ${i}: invalid hours for ${type}`);
      rejected.push(i);
      directives.push(noOp(i, REJECTED_EXPLANATION));
      continue;
    }

    let structured: StructuredAdjustment | null = null;

    if (type === "solar_reduction") {
      const factor = typeof adj.factor === "string" ? Number(adj.factor) : adj.factor;
      if (!isNum(factor) || factor < 0 || factor > 1) {
        repairs.push(`note ${i}: factor outside 0..1`);
        rejected.push(i);
        directives.push(noOp(i, REJECTED_EXPLANATION));
        continue;
      }
      structured = { hours, factor: round(factor, 6) };
    } else if (type === "minimum_battery_reserve") {
      const value =
        typeof adj.minimum_energy_kwh === "string"
          ? Number(adj.minimum_energy_kwh)
          : adj.minimum_energy_kwh;
      if (!isNum(value) || value < 0 || value > batteryCapacityKwh) {
        repairs.push(`note ${i}: reserve outside 0..capacity`);
        rejected.push(i);
        directives.push(noOp(i, REJECTED_EXPLANATION));
        continue;
      }
      structured = { hours, minimum_energy_kwh: round(value, 6) };
    } else if (type === "max_grid_window") {
      const value =
        typeof adj.max_grid_kwh === "string" ? Number(adj.max_grid_kwh) : adj.max_grid_kwh;
      if (!isNum(value) || value < 0) {
        repairs.push(`note ${i}: max_grid_kwh invalid`);
        rejected.push(i);
        directives.push(noOp(i, REJECTED_EXPLANATION));
        continue;
      }
      structured = { hours, max_grid_kwh: round(value, 6) };
    } else {
      // no_charge_window / no_discharge_window
      structured = { hours };
    }

    // applies semantics are enforced here, never taken from the model.
    if (entry.applies === false) {
      repairs.push(`note ${i}: applies corrected to true for ${type}`);
    }

    directives.push({
      note_index: i,
      applies: true,
      directive_type: type,
      structured_adjustment: structured,
      explanation,
    });
  }

  return { directives, repairs, rejected };
}
