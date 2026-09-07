// LOCAL PATCH (pi-pi): trimmed re-export surface. pi-pi consumes the vendored
// engine as a library (compaction dispatcher + vcc_recall) rather than loading
// it as an extension, so only these symbols are public.
export { compile, type CompileInput } from "./src/core/summarize";
export { registerRecallTool } from "./src/tools/recall";
export type { PiVccCompactionDetails } from "./src/details";
export type { FileOps } from "./src/types";
