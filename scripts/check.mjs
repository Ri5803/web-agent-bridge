import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
let files = 0;
for (const folder of ["src", "extension", "scripts", "test"]) {
  for (const file of readdirSync(join(root, folder))) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ["--check", join(root, folder, file)], {
      encoding: "utf8", windowsHide: true
    });
    if (result.status !== 0) {
      console.error(result.stderr);
      process.exit(1);
    }
    files++;
  }
}
console.log(`Syntax checked ${files} JavaScript files.`);
