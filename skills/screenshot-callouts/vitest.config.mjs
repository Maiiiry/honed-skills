// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Tests run against a font cache built in a temp dir, so they never read the machine's own cache.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.mjs"],
    testTimeout: 60_000,
    // Several test files launch Chromium, and each worker can hold one; unbounded workers ran
    // past 4 GB of memory.
    maxWorkers: 2,
    include: ["tests/**/*.test.mjs"],
  },
});
