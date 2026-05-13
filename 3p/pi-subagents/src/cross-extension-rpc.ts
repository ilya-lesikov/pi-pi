/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
}

export interface SpawnRequest {
  requestId: string;
  type: string;
  prompt: string;
  options?: any;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  isSubagentSession?: (ctx: unknown) => boolean;
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

function emitReply(events: EventBus, channel: string, requestId: string, reply: RpcReply<unknown>): void {
  events.emit(`${channel}:reply:${requestId}`, reply);
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, isSubagentSession, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = events.on("subagents:rpc:spawn", (raw: unknown) => {
    const params = raw as SpawnRequest;
    const ctx = getCtx();
    if (!ctx) {
      emitReply(events, "subagents:rpc:spawn", params.requestId, { success: false, error: "No active session" });
      return;
    }
    if (isSubagentSession?.(ctx)) {
      emitReply(events, "subagents:rpc:spawn", params.requestId, {
        success: false,
        error: "Cannot spawn subagents from a subagent session context",
      });
      return;
    }

    queueMicrotask(() => {
      try {
        const rawOpts = params.options ?? {};
        const spawnOpts = { ...rawOpts, isBackground: rawOpts.isBackground ?? rawOpts.run_in_background ?? true };
        const id = manager.spawn(pi, ctx, params.type, params.prompt, spawnOpts);
        events.emit("subagents:created", {
          id,
          type: params.type,
          description: params.options?.description ?? params.type,
          isBackground: params.options?.run_in_background ?? true,
        });
        emitReply(events, "subagents:rpc:spawn", params.requestId, { success: true, data: { id } });
      } catch (err: any) {
        emitReply(events, "subagents:rpc:spawn", params.requestId, {
          success: false,
          error: err?.message ?? String(err),
        });
      }
    });
  });

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      if (!manager.abort(agentId)) throw new Error("Agent not found");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop };
}
