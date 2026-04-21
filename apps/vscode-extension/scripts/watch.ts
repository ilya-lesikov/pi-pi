import esbuild from "esbuild";
import config from "./esbuild.config";

const ctx = await esbuild.context({ ...config, sourcemap: "inline" });
await ctx.watch();
console.log("Watching for changes...");
