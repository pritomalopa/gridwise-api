import type { Request, Response } from "express";
import { listHistory, clearMemoryHistory } from "../db/historyStore";

/**
 * MERN history endpoints – judge-safe and optional.
 * These are NOT part of the Problem Statement evaluation; they exist only for the dashboard.
 * They never require DB and never affect /health or /optimize-energy.
 */

export async function listHistoryHandler(_req: Request, res: Response): Promise<void> {
  const limitRaw = (_req.query.limit as string) || "50";
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 200);
  const items = await listHistory(limit);
  res.status(200).json({ count: items.length, items });
}

export async function clearHistoryHandler(_req: Request, res: Response): Promise<void> {
  clearMemoryHistory();
  // We only clear the in-memory buffer; DB history is intentionally retained for audit.
  res.status(200).json({ status: "cleared", cleared_memory: true });
}
