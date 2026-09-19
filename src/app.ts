import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { optimizeEnergyHandler } from "./routes/optimizeEnergy";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: "4mb" }));

  // Malformed JSON never reaches the handler; it is a 400 by contract.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
      res.status(400).json({ error: "invalid_request", details: ["request body is not valid JSON"] });
      return;
    }
    if (err && err.type === "entity.too.large") {
      res.status(400).json({ error: "invalid_request", details: ["request body too large"] });
      return;
    }
    next(err);
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/optimize-energy", (req: Request, res: Response, next: NextFunction) => {
    optimizeEnergyHandler(req, res).catch(next);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  // Controlled 500: log server side, never expose a stack trace or a secret.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[unhandled]", err instanceof Error ? err.message : err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
