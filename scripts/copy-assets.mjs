// Copies static assets that the main process reads at runtime (prompts/)
// into the build output. electron-vite bundles JS only, so without this the
// packaged app cannot find the prompt files.
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outMain = join(root, "out", "main");

mkdirSync(outMain, { recursive: true });
cpSync(join(root, "src", "main", "prompts"), join(outMain, "prompts"), {
  recursive: true,
});
console.log("copied src/main/prompts -> out/main/prompts");
