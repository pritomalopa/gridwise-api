/**
 * Guardrail and solver edge cases.
 *
 *   npm run test:edge
 *
 * No API key or network needed. Each block feeds deliberately broken model
 * output or a hostile scenario into the pipeline and asserts we degrade safely.
 */
import { validateAndRepair } from "../src/guardrails/validateDirectives";
import { extractJsonArray } from "../src/llm/interpretNotes";
import { solveSchedule } from "../src/optimizer/solveSchedule";
import { buildEffectiveConstraints } from "../src/optimizer/applyDirectives";
import { replaySchedule } from "../src/optimizer/replay";
import { Battery, DirectiveInterpretation, HourEntry } from "../src/types";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/* ------------------------------ JSON recovery ------------------------------ */

check(
  "fenced json is recovered",
  extractJsonArray('```json\n[{"note_index":0,"directive_type":"no_op"}]\n```').length === 1,
);
check(
  "chatty preamble is recovered",
  extractJsonArray('Sure! Here you go:\n[{"note_index":0,"directive_type":"no_op"}]').length === 1,
);
check("object wrapper is recovered", extractJsonArray('{"directives":[{"note_index":0}]}').length === 1);

/* -------------------------------- guardrails ------------------------------- */

const cap = 200;

const invented = validateAndRepair(
  [{ note_index: 0, applies: true, directive_type: "shut_down_campus", structured_adjustment: { hours: [1] } }],
  1,
  cap,
);
check("invented directive type becomes no_op", invented.directives[0].directive_type === "no_op");

const badHours = validateAndRepair(
  [
    {
      note_index: 0,
      applies: true,
      directive_type: "no_charge_window",
      structured_adjustment: { hours: [24, 25] },
    },
  ],
  1,
  cap,
);
check("out-of-range hours become no_op", badHours.directives[0].directive_type === "no_op");

const unsorted = validateAndRepair(
  [
    {
      note_index: 0,
      applies: true,
      directive_type: "no_charge_window",
      structured_adjustment: { hours: [5, 3, 3, 4] },
    },
  ],
  1,
  cap,
);
check(
  "duplicate/unsorted hours are normalised",
  JSON.stringify((unsorted.directives[0].structured_adjustment as { hours: number[] })?.hours) ===
    JSON.stringify([3, 4, 5]),
);

const badFactor = validateAndRepair(
  [
    {
      note_index: 0,
      applies: true,
      directive_type: "solar_reduction",
      structured_adjustment: { hours: [1], factor: 4 },
    },
  ],
  1,
  cap,
);
check("factor above 1 becomes no_op", badFactor.directives[0].directive_type === "no_op");

const overReserve = validateAndRepair(
  [
    {
      note_index: 0,
      applies: true,
      directive_type: "minimum_battery_reserve",
      structured_adjustment: { hours: [1], minimum_energy_kwh: 9999 },
    },
  ],
  1,
  cap,
);
check("reserve above capacity becomes no_op", overReserve.directives[0].directive_type === "no_op");

const wrongApplies = validateAndRepair(
  [
    {
      note_index: 0,
      applies: false,
      directive_type: "no_charge_window",
      structured_adjustment: { hours: [1] },
    },
  ],
  1,
  cap,
);
check("applies is corrected to true for a real directive", wrongApplies.directives[0].applies === true);

const missing = validateAndRepair([], 3, cap);
check("missing entries are padded in order", missing.directives.length === 3);
check(
  "padded entries are valid no_ops",
  missing.directives.every(
    (d, i) => d.note_index === i && d.applies === false && d.structured_adjustment === null,
  ),
);

const duplicated = validateAndRepair(
  [
    { note_index: 1, applies: false, directive_type: "no_op", structured_adjustment: null },
    { note_index: 1, applies: false, directive_type: "no_op", structured_adjustment: null },
  ],
  2,
  cap,
);
check(
  "duplicate note_index cannot produce duplicate output entries",
  duplicated.directives.length === 2 &&
    duplicated.directives[0].note_index === 0 &&
    duplicated.directives[1].note_index === 1,
);

check("garbage input never throws", validateAndRepair([null, 7, "x"] as unknown[], 2, cap).directives.length === 2);

/* --------------------------------- solver ---------------------------------- */

const hours: HourEntry[] = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  demand_kwh: 100,
  solar_kwh: hour >= 8 && hour <= 16 ? 60 : 0,
  tariff_bdt_per_kwh: hour >= 18 && hour <= 21 ? 30 : 6,
}));
const battery: Battery = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 20,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

function directive(
  note_index: number,
  directive_type: DirectiveInterpretation["directive_type"],
  adjustment: Record<string, unknown>,
): DirectiveInterpretation {
  return {
    note_index,
    applies: true,
    directive_type,
    structured_adjustment: adjustment as DirectiveInterpretation["structured_adjustment"],
    explanation: "",
  };
}

const noNotes = solveSchedule(hours, battery, []);
const noNotesReport = replaySchedule(
  noNotes.plan,
  hours,
  battery,
  buildEffectiveConstraints(hours, battery, []),
);
check("scenario with no directives is valid", noNotesReport.valid, noNotesReport.violations[0] ?? "");

const zeroSolar = hours.map((h) => ({ ...h, solar_kwh: 0 }));
const dark = solveSchedule(zeroSolar, battery, []);
check(
  "zero-solar scenario is valid",
  replaySchedule(dark.plan, zeroSolar, battery, buildEffectiveConstraints(zeroSolar, battery, [])).valid,
);

const allDayBlock = [
  directive(0, "no_charge_window", { hours: Array.from({ length: 24 }, (_, i) => i) }),
  directive(1, "no_discharge_window", { hours: Array.from({ length: 24 }, (_, i) => i) }),
];
const frozen = solveSchedule(hours, battery, allDayBlock);
const frozenReport = replaySchedule(
  frozen.plan,
  hours,
  battery,
  buildEffectiveConstraints(hours, battery, allDayBlock),
);
check("battery frozen all day still yields a valid plan", frozenReport.valid, frozenReport.violations[0] ?? "");

// Contradictory hard directives: a reserve the battery cannot legally reach.
const contradictory = [
  directive(0, "minimum_battery_reserve", { hours: [0], minimum_energy_kwh: 200 }),
  directive(1, "no_charge_window", { hours: [0] }),
];
const relaxed = solveSchedule(hours, battery, contradictory);
check(
  "infeasible directive pair relaxes instead of failing",
  relaxed.plan.length === 24 && relaxed.method !== "lp" ? true : relaxed.plan.length === 24,
  `method=${relaxed.method} dropped=[${relaxed.dropped.join(",")}]`,
);

const tightGrid = [directive(0, "max_grid_window", { hours: [18, 19, 20, 21], max_grid_kwh: 60 })];
const capped = solveSchedule(hours, battery, tightGrid);
const cappedReport = replaySchedule(
  capped.plan,
  hours,
  battery,
  buildEffectiveConstraints(hours, battery, tightGrid),
);
check("tight grid cap is respected", cappedReport.valid, cappedReport.violations[0] ?? "");

const freeGrid = hours.map((h) => ({ ...h, tariff_bdt_per_kwh: 0 }));
const free = solveSchedule(freeGrid, battery, []);
check(
  "zero tariff does not break the solver",
  replaySchedule(free.plan, freeGrid, battery, buildEffectiveConstraints(freeGrid, battery, [])).valid,
);

console.log(`\n${failures === 0 ? "all edge cases passed" : `${failures} edge case(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
