import { defineConfig } from "vitest/config";

export default defineConfig({
  // Bind the internal test server to loopback explicitly: some sandboxes have no
  // `localhost` entry in /etc/hosts, which makes Vitest fail before the first test.
  server: { host: "127.0.0.1" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"]
    // The UI test opts into jsdom with a per-file `@vitest-environment` comment.
  }
});
