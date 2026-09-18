/** Absolute tolerance used by the judge (0.01 kWh / 0.01 BDT). */
export const TOL = 0.01;

/** Internal rounding precision. Far tighter than the judge tolerance. */
const DP = 4;

export function round(value: number, dp: number = DP): number {
  if (!Number.isFinite(value)) return 0;
  const f = Math.pow(10, dp);
  const r = Math.round((value + Number.EPSILON) * f) / f;
  // normalise -0 to 0 so responses never contain "-0"
  return r === 0 ? 0 : r;
}

/** Clamp tiny negative float noise to exactly 0. */
export function clampNonNegative(value: number): number {
  return value < 0 && value > -1e-6 ? 0 : value;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

export function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
