import { parseArgs, resolveCliModel } from "@earendil-works/pi-coding-agent";

export interface CliModelRequest {
  model: string;
  provider?: string;
  thinking?: string;
}

/**
 * The model pi was started with (`--model`, `--provider`, `--thinking`), read
 * from pi's own command line: pi gives an extension no other way to tell a
 * model someone asked for from one it picked by default. Apps that drive pi
 * (bb, scripts) choose the model this way.
 */
export function cliModelRequest(argv: readonly string[] = process.argv.slice(2)): CliModelRequest | null {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs([...argv]);
  } catch {
    return null;
  }
  if (!parsed.model) return null;
  return { model: parsed.model, provider: parsed.provider, thinking: parsed.thinking };
}

/**
 * Resolves the request against the models registered now, pi-pi's own
 * providers included: pi resolved `--model` before those existed, so a model
 * only pi-pi provides was rejected there and the session started on another.
 * Same matching rules as pi (provider/model, fuzzy id, `model:thinking`).
 */
export function resolveCliRequest(request: CliModelRequest, registry: any): { model: any; thinking?: string } | null {
  if (!registry?.getAll) return null;
  const runtime = {
    getModels: () => registry.getAll(),
    hasConfiguredAuth: (provider: string) => registry.getAll().some((model: any) => model.provider === provider && registry.hasConfiguredAuth?.(model)),
  };
  try {
    const resolved = resolveCliModel({ cliProvider: request.provider, cliModel: request.model, cliThinking: request.thinking as any, modelRuntime: runtime as any });
    if (!resolved.model) return null;
    return { model: resolved.model, thinking: request.thinking ?? resolved.thinkingLevel };
  } catch {
    return null;
  }
}
