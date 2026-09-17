import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(projectRoot, "vendor");
const ortDist = join(projectRoot, "node_modules", "onnxruntime-web", "dist");

await build({
  entryPoints: [join(projectRoot, "offscreen-source.js")],
  outfile: join(projectRoot, "offscreen.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome116",
  minify: true,
  legalComments: "none"
});

await rm(vendorDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });
for (const filename of await readdir(ortDist)) {
  if (/^ort-wasm.*\.(mjs|wasm)$/.test(filename)) {
    await cp(join(ortDist, filename), join(vendorDir, filename));
  }
}
