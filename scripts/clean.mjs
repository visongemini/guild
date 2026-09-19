/**
 * Removes only workspace compile outputs and their incremental graphs
 * so `tsc -b` cannot reuse stale dist/*.test.js after a source test is deleted.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const TARGETS = [
  join(repoRoot, "packages/contracts/dist"),
  join(repoRoot, "packages/domain/dist"),
  join(repoRoot, "packages/persistence/dist"),
  join(repoRoot, "packages/runtime-grok/dist"),
  join(repoRoot, "packages/ui/dist"),
  join(repoRoot, "apps/desktop/dist"),
  join(repoRoot, "packages/contracts/tsconfig.tsbuildinfo"),
  join(repoRoot, "packages/domain/tsconfig.tsbuildinfo"),
  join(repoRoot, "packages/persistence/tsconfig.tsbuildinfo"),
  join(repoRoot, "packages/runtime-grok/tsconfig.tsbuildinfo"),
  join(repoRoot, "packages/ui/tsconfig.tsbuildinfo"),
  join(repoRoot, "apps/desktop/tsconfig.main.tsbuildinfo"),
  join(repoRoot, "apps/desktop/tsconfig.preload.tsbuildinfo"),
  join(repoRoot, "apps/desktop/tsconfig.renderer.tsbuildinfo"),
];

for (const target of TARGETS) {
  rmSync(target, { recursive: true, force: true });
}
