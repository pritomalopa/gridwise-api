declare module "javascript-lp-solver" {
  interface LpModel {
    optimize: string;
    opType: "min" | "max" | string;
    constraints: Record<string, Record<string, number>>;
    variables: Record<string, Record<string, number>>;
    ints?: Record<string, number>;
    binaries?: Record<string, number>;
  }
  interface LpResult {
    feasible: boolean;
    result: number;
    bounded: boolean;
    [variable: string]: number | boolean;
  }
  const solver: {
    Solve(model: LpModel, precision?: number, full?: boolean): LpResult;
  };
  export default solver;
}
