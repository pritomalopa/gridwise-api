/**
 * Runs every public sample case against a running GridWise service.
 *
 *   npm run test:samples                       # against http://localhost:8080
 *   BASE_URL=https://my-app.onrender.com npm run test:samples
 *   npm run test:samples -- --dump             # also write full request JSONs
 *
 * It checks three things per case:
 *   1. directive_interpretation matches the published ground truth
 *   2. hourly_plan is valid under the ground-truth directives (independent replay)
 *   3. recalculated cost versus the published reference optimal cost
 */
import fs from "node:fs";
import path from "node:path";
import {
  Battery,
  DirectiveInterpretation,
  HourEntry,
  OptimizeResponse,
  ScenarioRequest,
} from "../src/types";
import { buildEffectiveConstraints } from "../src/optimizer/applyDirectives";
import { replaySchedule } from "../src/optimizer/replay";

const here = __dirname;
const fixturePath = path.join(here, "..", "tests", "public-samples.json");
const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const DUMP = process.argv.includes("--dump");

interface ExpectedDirective {
  applies: boolean;
  directive_type: string;
  hours?: number[];
  factor?: number;
  minimum_energy_kwh?: number;
  max_grid_kwh?: number;
}

interface Fixture {
  profiles: Record<string, [number, number, number][]>;
  cases: {
    id: string;
    profile: string;
    battery: [number, number, number, number, number];
    operator_notes: string[];
    expected: ExpectedDirective[];
    reference_cost_bdt: number;
  }[];
}

const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function expand(caseDef: Fixture["cases"][number]): ScenarioRequest {
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
  return {
    scenario_id: caseDef.id,
    operator_notes: caseDef.operator_notes,
    hours,
    battery,
  };
}

function groundTruth(expected: ExpectedDirective[]): DirectiveInterpretation[] {
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

function compareDirectives(
  got: DirectiveInterpretation[],
  expected: ExpectedDirective[],
): string[] {
  const issues: string[] = [];
  if (!Array.isArray(got) || got.length !== expected.length) {
    return [`expected ${expected.length} interpretation entries, got ${got?.length ?? 0}`];
  }
  expected.forEach((want, i) => {
    const have = got[i];
    if (have.note_index !== i) issues.push(`entry ${i}: note_index is ${have.note_index}`);
    if (have.directive_type !== want.directive_type) {
      issues.push(`note ${i}: type ${have.directive_type} != ${want.directive_type}`);
      return;
    }
    if (have.applies !== want.applies) issues.push(`note ${i}: applies ${have.applies}`);
    if (!want.applies) {
      if (have.structured_adjustment !== null) {
        issues.push(`note ${i}: no_op must carry a null adjustment`);
      }
      return;
    }
    const adj = (have.structured_adjustment ?? {}) as Record<string, number | number[]>;
    const hours = adj.hours as number[] | undefined;
    if (JSON.stringify(hours) !== JSON.stringify(want.hours)) {
      issues.push(`note ${i}: hours ${JSON.stringify(hours)} != ${JSON.stringify(want.hours)}`);
    }
    for (const key of ["factor", "minimum_energy_kwh", "max_grid_kwh"] as const) {
      const wanted = want[key];
      if (wanted === undefined) continue;
      const actual = adj[key] as number | undefined;
      if (actual === undefined || Math.abs(actual - wanted) > 0.01) {
        issues.push(`note ${i}: ${key} ${actual} != ${wanted}`);
      }
    }
  });
  return issues;
}

async function main(): Promise<void> {
  console.log(`GridWise public sample run against ${BASE_URL}\n`);

  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error("health check failed - is the service running?");
    process.exit(1);
  }
  console.log("health: ok\n");

  if (DUMP) {
    const dir = path.join(here, "..", "tests", "requests");
    fs.mkdirSync(dir, { recursive: true });
    for (const c of fixture.cases) {
      fs.writeFileSync(
        path.join(dir, `${c.id}.json`),
        `${JSON.stringify(expand(c), null, 2)}\n`,
      );
    }
    console.log(`wrote full request bodies to tests/requests/\n`);
  }

  let passed = 0;
  let ratioSum = 0;
  const latencies: number[] = [];

  for (const caseDef of fixture.cases) {
    const request = expand(caseDef);
    const started = Date.now();
    const res = await fetch(`${BASE_URL}/optimize-energy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const elapsed = Date.now() - started;
    latencies.push(elapsed);

    if (!res.ok) {
      console.log(`${caseDef.id}  FAIL  http ${res.status}`);
      continue;
    }
    const body = (await res.json()) as OptimizeResponse;
    const issues: string[] = [];

    if (body.scenario_id !== caseDef.id) issues.push("scenario_id not echoed");
    issues.push(...compareDirectives(body.directive_interpretation, caseDef.expected));

    // Validity is checked against the published ground truth, exactly like the judge.
    const truth = groundTruth(caseDef.expected);
    const constraints = buildEffectiveConstraints(request.hours, request.battery, truth);
    const report = replaySchedule(body.hourly_plan ?? [], request.hours, request.battery, constraints);
    issues.push(...report.violations.slice(0, 4));

    if (Math.abs(report.total_cost_bdt - body.total_cost_bdt) > 0.01) {
      issues.push(`reported total_cost_bdt ${body.total_cost_bdt} != replayed ${report.total_cost_bdt.toFixed(2)}`);
    }
    if (Math.abs(report.total_grid_kwh - body.total_grid_kwh) > 0.01) {
      issues.push(`reported total_grid_kwh ${body.total_grid_kwh} != replayed ${report.total_grid_kwh.toFixed(2)}`);
    }
    if (Math.abs(report.peak_grid_kwh - body.peak_grid_kwh) > 0.01) {
      issues.push(`reported peak_grid_kwh ${body.peak_grid_kwh} != replayed ${report.peak_grid_kwh.toFixed(2)}`);
    }

    const ratio = report.valid
      ? Math.min(1, caseDef.reference_cost_bdt / Math.max(report.total_cost_bdt, 1e-9))
      : 0;
    ratioSum += ratio;

    const ok = issues.length === 0;
    if (ok) passed++;
    console.log(
      `${caseDef.id}  ${ok ? "PASS" : "FAIL"}  cost=${report.total_cost_bdt.toFixed(2)} ` +
        `ref=${caseDef.reference_cost_bdt} ratio=${ratio.toFixed(4)} ${elapsed}ms`,
    );
    for (const issue of issues) console.log(`            - ${issue}`);
  }

  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
  console.log(
    `\n${passed}/${fixture.cases.length} cases fully passed | ` +
      `avg cost ratio ${(ratioSum / fixture.cases.length).toFixed(4)} | p95 latency ${p95}ms`,
  );
  process.exit(passed === fixture.cases.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
