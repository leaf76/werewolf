import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// vitest-pool-workers for Vitest 4 replaced the pool + poolOptions.workers
// setup with this plugin and dropped the isolatedStorage / singleWorker
// switches. These tests never relied on per-test isolation: every test
// allocates its own room code, so nothing leaks between them.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
