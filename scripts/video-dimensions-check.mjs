import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "ms2133-video-dimensions-"));
const output = path.join(tempDir, "video-dimensions.mjs");
try {
  await build({
    entryPoints: ["src/video-dimensions.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
    logLevel: "silent",
  });
  const dimensions = await import(`${pathToFileURL(output).href}?check=${Date.now()}`);
  for (const pair of [[416, 416], [448, 416], [416, 448], [448, 448]]) {
    assert.equal(dimensions.matchesRequestedDimensions(pair[0], pair[1], 416), true, `416 alias ${pair.join("×")}`);
    assert.deepEqual(dimensions.normalizeReportedDimensions(pair[0], pair[1], 416), { width: 416, height: 416 });
  }
  assert.equal(dimensions.matchesRequestedDimensions(448, 448, 448), true, "a genuine 448 request remains valid");
  assert.deepEqual(dimensions.normalizeReportedDimensions(448, 448, 448), { width: 448, height: 448 });
  assert.equal(dimensions.matchesRequestedDimensions(448, 448, 512), false, "416 alias is scoped to the requested mode");
  assert.deepEqual(dimensions.normalizeReportedDimensions(448, 448, null), { width: 448, height: 448 });
  console.log("Video dimension normalization checks passed: 416 aliases are scoped and normalized.");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
