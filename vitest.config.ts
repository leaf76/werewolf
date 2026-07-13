import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Per-test isolated storage chokes on the .sqlite-shm sidecar files of
        // SQLite-backed Durable Objects (see vitest-integration known issues).
        // Tests share one storage instead; every test allocates its own room
        // code, so nothing leaks between them.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
