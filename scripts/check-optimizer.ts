/**
 * Offline correctness check for the scheduler.
 *
 *   npm run test:optimizer
 *
 * Feeds the published ground-truth directives straight into the optimizer, so it
 * needs no API key, no network and no running server. It proves the directive
 * application, energy accounting and cost minimisation are correct in isolation
 * from the language-model step.
 */
import fs from "node:fs";
import path from "node:path";
import { Battery, DirectiveInterpretation, HourEntry } from "../src/types";
import { solveSchedule } from "../src/optimizer/solveSchedule";
import { buildEffectiveConstraints } from "../src/optimizer/applyDirectives";
import { replaySchedule } from "../src/optimizer/replay";

interface ExpectedDirective {
  applies: boolean;
  directive_type: string;
  hours?: number[];
  factor?: number;
  minimum_energy_kwh?: number;
  max_grid_kwh?: number;
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "tests", "public-samples.json"), "utf8"),
) as {
  profiles: Record<string, [number, number, number][]>;
  cases: {
    id: string;
    profile: string;
    battery: [number, number, number, number, number];
    operator_notes: string[];
    expected: ExpectedDirective[];
    reference_cost_bdt: number;
  }[];
};

function toDirectives(expected: ExpectedDirective[]): DirectiveInterpretation[] {
  return expected.map((e, note_index) => {
    if (!e.applies) {
      return {
        note_index,
        applies: false,
        directive_type: "no_op" as const,
        structured_adjustment: null,
        explanation: "",
      };
    }
    const adj: Record<string, unknown> = { hours: e.hours };
    if (e.factor !== undefined) adj.factor = e.factor;
    if (e.minimum_energy_kwh !== undefined) adj.minimum_energy_kwh = e.minimum_energy_kwh;
    if (e.max_grid_kwh !== undefined) adj.max_grid_kwh = e.max_grid_kwh;
    return {
      note_index,
      applies: true,
      directive_type: e.directive_type as DirectiveInterpretation["directive_type"],
      structured_adjustment: adj as DirectiveInterpretation["structured_adjustment"],
      explanation: "",
    };
  });
}

let failures = 0;
let ratioSum = 0;
let totalMs = 0;

for (const caseDef of fixture.cases) {
  const rows = fixture.profiles[caseDef.profile];
  const hours: HourEntry[] = rows.map((row, hour) => ({
    hour,
    demand_kwh: row[0],
    solar_kwh: row[1],
    tariff_bdt_per_kwh: row[2],
  }));
  const [capacity, initial, minimum, maxCharge, maxDischarge] = caseDef.battery;
  const battery: Battery = {
    capacity_kwh: capacity,
    initial_energy_kwh: initial,
    minimum_energy_kwh: minimum,
    max_charge_kwh_per_hour: maxCharge,
    max_discharge_kwh_per_hour: maxDischarge,
  };

  const directives = toDirectives(caseDef.expected);
  const started = Date.now();
  const outcome = solveSchedule(hours, battery, directives);
  const elapsed = Date.now() - started;
  totalMs += elapsed;

  const constraints = buildEffectiveConstraints(hours, battery, directives);
  const report = replaySchedule(outcome.plan, hours, battery, constraints);
  const ratio = report.valid
    ? Math.min(1, caseDef.reference_cost_bdt / Math.max(report.total_cost_bdt, 1e-9))
    : 0;
  ratioSum += ratio;

  const ok = report.valid && ratio > 0.9999;
  if (!ok) failures++;

  console.log(
    `${caseDef.id}  ${ok ? "PASS" : "FAIL"}  method=${outcome.method} ` +
      `cost=${report.total_cost_bdt.toFixed(2)} ref=${caseDef.reference_cost_bdt} ` +
      `ratio=${ratio.toFixed(4)} ${elapsed}ms`,
  );
  for (const v of report.violations.slice(0, 6)) console.log(`            - ${v}`);
}

console.log(
  `\n${fixture.cases.length - failures}/${fixture.cases.length} optimizer cases passed | ` +
    `avg ratio ${(ratioSum / fixture.cases.length).toFixed(4)} | solver time ${totalMs}ms total`,
);
process.exit(failures === 0 ? 0 : 1);
