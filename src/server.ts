import { createApp } from "./app";
import { config, activeApiKeyPresent } from "./config";
import { initHistoryStore } from "./db/historyStore";

const app = createApp();

// Warm up optional DB (MongoDB/Postgres) in background – never blocks health/optimize.
initHistoryStore().catch(() => {});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    `GridWise API listening on 0.0.0.0:${config.port} | provider=${config.llmProvider} model=${config.llmModel} key=${
      activeApiKeyPresent() ? "configured" : "MISSING"
    }`,
  );
  if (!activeApiKeyPresent()) {
    console.warn(
      "No model API key found. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY with LLM_PROVIDER=openai).",
    );
  }
});

// Keep the process alive through unexpected async failures.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
