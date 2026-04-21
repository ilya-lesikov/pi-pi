import type { BuildOptions } from "esbuild";

const config: BuildOptions = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outdir: "./dist",
  outbase: "./src",
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  external: ["vscode"],
  loader: { ".ts": "ts" },
  logLevel: "info",
  sourcemap: "linked",
};

export default config;
