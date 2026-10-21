// pi-pi's bb plugin backend: reads the state file pi-pi writes into a thread's
// storage directory and drops worker commands next to it. Both go through
// bb's file API on the machine that owns the thread, so remote machines work too.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BbCommand, BbState } from "./state";

const threadInput = z.object({ threadId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  state_get: {
    input: threadInput,
    // Validated by pi-pi's writer; the plugin only checks the version it understands.
    output: z.object({ state: z.custom<BbState>().nullable() }),
  },
  command_send: {
    input: threadInput.extend({
      workerId: z.string().min(1).max(200),
      action: z.enum(["stop", "kill", "message"]),
      text: z.string().max(20_000).optional(),
    }),
    output: z.object({ id: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  // A thread's storage directory never moves while the thread exists.
  const locations = new Map<string, { hostId: string; dir: string }>();
  const locate = async (threadId: string) => {
    const known = locations.get(threadId);
    if (known) return known;
    const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({ threadId });
    const location = { hostId, dir: `${storageRootPath.replace(/\/+$/, "")}/pi-pi` };
    locations.set(threadId, location);
    return location;
  };

  bb.rpc.register(rpcContract, {
    state_get: async ({ threadId }) => {
      let location: { hostId: string; dir: string };
      try {
        location = await locate(threadId);
      } catch {
        return { state: null };
      }
      try {
        const file = await bb.sdk.files.read({ hostId: location.hostId, path: `${location.dir}/state.json` });
        if (file.contentEncoding !== "utf8") return { state: null };
        const state = JSON.parse(file.content) as BbState;
        return { state: state?.version === 1 ? state : null };
      } catch {
        // No file yet (not a pi-pi thread, or nothing written), or a machine offline.
        return { state: null };
      }
    },
    command_send: async ({ threadId, workerId, action, text }) => {
      const { hostId, dir } = await locate(threadId);
      const command: BbCommand = { id: randomUUID(), workerId, action, ...(text !== undefined ? { text } : {}) };
      const name = `${Date.now()}-${command.id}.json`;
      // Written aside and moved in, so pi never reads half a command.
      const temp = `${dir}/commands/${name}.tmp`;
      await bb.sdk.files.write({ hostId, path: temp, content: JSON.stringify(command), createParents: true });
      try {
        await bb.sdk.files.move({ hostId, sourcePath: temp, destinationPath: `${dir}/commands/${name}` });
      } catch (error) {
        // pi never picks up a .tmp, so nothing else would ever remove it.
        await bb.sdk.files.remove({ hostId, path: temp }).catch(() => {});
        throw error;
      }
      return { id: command.id };
    },
  });
}
