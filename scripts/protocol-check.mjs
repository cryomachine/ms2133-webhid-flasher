import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const path = name => fileURLToPath(new URL(name, root));
await build({
  entryPoints: [path("src/webhid-protocol.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path("tests/webhid-protocol.test-bundle.mjs"),
  plugins: [{
    name: "offline-backend",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/backend$/ }, () => ({ path: "backend", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export function registerWebHidDriver(driver) { globalThis.__ms2133RegisteredDriver=driver; }" }));
    },
  }],
});
// bulk imports the shared legacy suite once. All devices are in-memory mocks.
const result = spawnSync(process.execPath, ["--test", ...["driver", "flash", "bulk", "maintenance"].map(name => path(`tests/webhid-${name}.test.mjs`))], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
