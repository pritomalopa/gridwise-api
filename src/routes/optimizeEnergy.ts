import type { Request, Response } from "express";
import { validateScenarioRequest } from "../validation/requestSchema";
import { interpretNotesWithLlm } from "../llm/interpretNotes";
import { fallbackInterpret } from "../llm/fallbackInterpreter";
import { validateAndRepair } from "../guardrails/validateDirectives";
import { solveSchedule } from "../optimizer/solveSchedule";
import { DirectiveInterpretation, OptimizeResponse } from "../types";
import { round } from "../utils/num";

function buildSummary(
  directives: DirectiveInterpretation[],
  peakGrid: number,
  totalCost: number,
): string {
  const applied = directives.filter((d) => d.applies);
  const parts: string[] = [];

  if (applied.length === 0) {
    parts.push("No operator note changed today's operating limits");
  } else {
    const labels = applied.map((d) => {
      switch (d.directive_type) {
        case "solar_reduction":
          return "reduced usable solar";
        case "minimum_battery_reserve":
          return "a raised battery reserve";
        case "no_charge_window":
          return "a no-charge window";
        case "no_discharge_window":
          return "a no-discharge window";
        case "max_grid_window":
          return "a grid-import cap";
        default:
          return "an operating limit";
      }
    });
    parts.push(`Applied ${labels.join(", ")}`);
  }

  const ignored = directives.length - applied.length;
  if (ignored > 0) {
    parts.push(`${ignored} unrelated note${ignored > 1 ? "s were" : " was"} ignored`);
  }

  parts.push(
    `battery energy was shifted from cheap hours into expensive ones, peak grid import is ${round(
      peakGrid,
      2,
    )} kWh, and the day ends at the starting battery level for a total grid cost of ${round(
      totalCost,
      2,
    )} BDT`,
  );

  return `${parts.join("; ")}.`;
}

export async function optimizeEnergyHandler(req: Request, res: Response): Promise<void> {
  const validation = validateScenarioRequest(req.body);
  if (!validation.ok || !validation.value) {
    res.status(400).json({
      error: "invalid_request",
      details: validation.errors.slice(0, 20),
    });
    return;
  }

  const scenario = validation.value;
  const noteCount = scenario.operator_notes.length;
  const capacity = scenario.battery.capacity_kwh;

  // 1) Mandatory LLM interpretation of the operator notes.
  const llm = await interpretNotesWithLlm(scenario.operator_notes, capacity);

  // 2) Deterministic guardrails. Model output is untrusted until it passes here.
  let guarded = validateAndRepair(llm.raw, noteCount, capacity);

  // Controlled degradation, case A: the provider itself failed or returned
  // nothing at all. The whole scenario falls back to the deterministic parser.
  const nothingUsable = guarded.directives.every((d) => d.directive_type === "no_op");
  if (llm.source === "fallback" || (nothingUsable && llm.raw.length === 0)) {
    console.warn(
      `[optimize-energy] scenario=${scenario.scenario_id} model unavailable (${
        llm.error ?? "no output"
      }); using deterministic fallback interpreter for all notes`,
    );
    const fallbackRaw = fallbackInterpret(scenario.operator_notes, capacity);
    guarded = validateAndRepair(fallbackRaw, noteCount, capacity);
  } else if (guarded.rejected.length > 0) {
    // Controlled degradation, case B: the model answered, but one or two
    // specific notes produced output that failed guardrail validation (bad
    // shape, out-of-range values, an unsupported type). Retry only those
    // notes through the deterministic parser instead of discarding a model
    // response that was otherwise fine.
    console.warn(
      `[optimize-energy] scenario=${scenario.scenario_id} retrying rejected notes ` +
        `[${guarded.rejected.join(",")}] via deterministic fallback`,
    );
    const fallbackRaw = fallbackInterpret(scenario.operator_notes, capacity);
    const fallbackGuarded = validateAndRepair(fallbackRaw, noteCount, capacity);
    for (const idx of guarded.rejected) {
      guarded.directives[idx] = fallbackGuarded.directives[idx];
    }
  }

  const directives = guarded.directives;
  if (guarded.repairs.length > 0) {
    console.warn(
      `[optimize-energy] scenario=${scenario.scenario_id} guardrail repairs: ${guarded.repairs.join(
        " | ",
      )}`,
    );
  }

  // 3) Directive application + cost-minimal scheduling.
  const outcome = solveSchedule(scenario.hours, scenario.battery, directives);

  if (outcome.method !== "lp") {
    console.warn(
      `[optimize-energy] scenario=${scenario.scenario_id} solver path=${
        outcome.method
      } dropped=[${outcome.dropped.join(",")}] violations=${outcome.report.violations
        .slice(0, 5)
        .join(" | ")}`,
    );
  }

  // 4) Totals are recomputed from hourly_plan, never taken from the solver.
  let totalGrid = 0;
  let totalCost = 0;
  let peakGrid = 0;
  for (const entry of outcome.plan) {
    totalGrid += entry.grid_kwh;
    totalCost += entry.grid_kwh * scenario.hours[entry.hour].tariff_bdt_per_kwh;
    peakGrid = Math.max(peakGrid, entry.grid_kwh);
  }

  const response: OptimizeResponse = {
    scenario_id: scenario.scenario_id,
    directive_interpretation: directives,
    hourly_plan: outcome.plan,
    total_grid_kwh: round(totalGrid, 2),
    total_cost_bdt: round(totalCost, 2),
    peak_grid_kwh: round(peakGrid, 2),
    plan_summary: buildSummary(directives, peakGrid, totalCost),
  };

  res.status(200).json(response);
}
