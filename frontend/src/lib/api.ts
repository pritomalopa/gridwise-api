export interface Battery {
  capacity_kwh: number;
  initial_energy_kwh: number;
  minimum_energy_kwh: number;
  max_charge_kwh_per_hour: number;
  max_discharge_kwh_per_hour: number;
}
export interface HourEntry {
  hour: number;
  demand_kwh: number;
  solar_kwh: number;
  tariff_bdt_per_kwh: number;
}
export interface OptimizeRequest {
  scenario_id: string;
  operator_notes: string[];
  hours: HourEntry[];
  battery: Battery;
}
export interface DirectiveInterpretation {
  note_index: number;
  applies: boolean;
  directive_type: string;
  structured_adjustment: Record<string, unknown> | null;
  explanation: string;
}
export interface HourlyPlanEntry {
  hour: number;
  grid_kwh: number;
  solar_used_kwh: number;
  battery_action: "charge" | "discharge" | "idle";
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

const BASE = (import.meta as unknown as { env: Record<string, string> }).env.VITE_API_BASE || "";

export async function healthCheck(): Promise<{ status: string; latency: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/health`);
  const j = await r.json();
  return { status: j.status, latency: Math.round(performance.now() - t0) };
}

export async function optimize(req: OptimizeRequest): Promise<OptimizeResponse> {
  const r = await fetch(`${BASE}/optimize-energy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(j.error ? `${j.error}: ${(j.details || []).join("; ")}` : JSON.stringify(j).slice(0, 600));
  }
  return j as OptimizeResponse;
}

export async function fetchHistory(limit = 50) {
  const r = await fetch(`${BASE}/api/history?limit=${limit}`);
  if (!r.ok) return { count: 0, items: [] as unknown[] };
  return (await r.json()) as { count: number; items: unknown[] };
}
