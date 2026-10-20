import { parseArgs } from "@earendil-works/pi-coding-agent";

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
