import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(projectRoot, "dist");
const applicationOutput = join(distRoot, "mac-arm64");

if (existsSync(applicationOutput)) {
  rmSync(applicationOutput, { recursive: true, force: true });
}

if (existsSync(distRoot)) {
  for (const name of readdirSync(distRoot)) {
    if (name.endsWith(".dmg") || name.endsWith(".blockmap") || name === "builder-effective-config.yaml") {
      rmSync(join(distRoot, name), { force: true });
    }
  }
}
