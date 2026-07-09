// Local-delta coverage for the pi-pi fork of pi-ask-user.
//
// Tests ONLY what differs from upstream: the exported askUser() entrypoint, the inline/pinned
// default display mode (upstream defaulted to overlay), allowComment defaulting ON, the
// cancel-reason sentinel plumbing (isCancel + user/timeout/signal), and the forked response
// shapes. The upstream cases invalidated by the inline default are FORK:-skipped in index.test.ts.
// Kept separate so upstream rebases re-apply the vendored suite cleanly.

import { describe, expect, test } from "bun:test";

import { askUser, isCancel } from "./index";

interface CustomCapture {
   options: any;
   factoryCalled: boolean;
}

// Fake ctx.ui.custom that records the `options` argument askUser passed (this is what encodes the
// inline-vs-overlay decision) and returns a fixed result. It deliberately does NOT invoke the
// factory/construct the real AskComponent — that needs the full pi-tui/theme mock harness the
// vendored suite sets up, and the options are already captured before the factory would run.
function fakeCtx(result: unknown, capture: CustomCapture, extra: Record<string, unknown> = {}) {
   return {
      hasUI: true,
      ui: {
         setWorkingMessage() {},
         notify() {},
         async custom(_factory: any, options: any) {
            capture.options = options;
            capture.factoryCalled = true;
            return result;
         },
         ...extra,
      },
   };
}

describe("askUser export (local fork)", () => {
   test("is exported as a callable function", () => {
      expect(typeof askUser).toBe("function");
   });

   test("returns null when the context has no UI", async () => {
      const result = await askUser({ hasUI: false, ui: null }, { question: "hi", options: ["A"] });
      expect(result).toBeNull();
   });

   test("defaults to inline display mode: ui.custom receives undefined (no overlay) options", async () => {
      const capture: CustomCapture = { options: "unset", factoryCalled: false };
      const ctx = fakeCtx({ kind: "selection", selections: ["A"] }, capture);

      await askUser(ctx, { question: "Pick", options: ["A", "B"] });

      expect(capture.factoryCalled).toBe(true);
      // buildCustomUIOptions("inline") === undefined — the fork's headline behavior change.
      expect(capture.options).toBeUndefined();
   });

   test("explicit overlay:true opts back into overlay options", async () => {
      const capture: CustomCapture = { options: "unset", factoryCalled: false };
      const ctx = fakeCtx({ kind: "selection", selections: ["A"] }, capture);

      await askUser(ctx, { question: "Pick", options: ["A", "B"], overlay: true });

      expect(capture.options?.overlay).toBe(true);
   });

   test("explicit displayMode:'overlay' opts back into overlay options", async () => {
      const capture: CustomCapture = { options: "unset", factoryCalled: false };
      const ctx = fakeCtx({ kind: "selection", selections: ["A"] }, capture);

      await askUser(ctx, { question: "Pick", options: ["A", "B"], displayMode: "overlay" });

      expect(capture.options?.overlay).toBe(true);
   });

   test("PI_ASK_USER_DISPLAY_MODE=overlay env var flips the default to overlay", async () => {
      const prev = process.env.PI_ASK_USER_DISPLAY_MODE;
      process.env.PI_ASK_USER_DISPLAY_MODE = "overlay";
      try {
         const capture: CustomCapture = { options: "unset", factoryCalled: false };
         const ctx = fakeCtx({ kind: "selection", selections: ["A"] }, capture);
         await askUser(ctx, { question: "Pick", options: ["A", "B"] });
         expect(capture.options?.overlay).toBe(true);
      } finally {
         if (prev === undefined) delete process.env.PI_ASK_USER_DISPLAY_MODE;
         else process.env.PI_ASK_USER_DISPLAY_MODE = prev;
      }
   });

   test("unrecognised PI_ASK_USER_DISPLAY_MODE falls back to inline (fork default)", async () => {
      const prev = process.env.PI_ASK_USER_DISPLAY_MODE;
      process.env.PI_ASK_USER_DISPLAY_MODE = "fullscreen";
      try {
         const capture: CustomCapture = { options: "unset", factoryCalled: false };
         const ctx = fakeCtx({ kind: "selection", selections: ["A"] }, capture);
         await askUser(ctx, { question: "Pick", options: ["A", "B"] });
         expect(capture.options).toBeUndefined();
      } finally {
         if (prev === undefined) delete process.env.PI_ASK_USER_DISPLAY_MODE;
         else process.env.PI_ASK_USER_DISPLAY_MODE = prev;
      }
   });

   test("passes the selection result straight through from ui.custom", async () => {
      const capture: CustomCapture = { options: "unset", factoryCalled: false };
      const ctx = fakeCtx({ kind: "selection", selections: ["B"], comment: "note" }, capture);

      const result = await askUser(ctx, { question: "Pick", options: ["A", "B"] });
      expect(result).toEqual({ kind: "selection", selections: ["B"], comment: "note" });
   });

   test("with no options, uses ui.input and normalizes a freeform response", async () => {
      let inputPrompt = "";
      const ctx = {
         hasUI: true,
         ui: {
            setWorkingMessage() {},
            async input(prompt: string) {
               inputPrompt = prompt;
               return "  typed answer  ";
            },
         },
      };
      const result = await askUser(ctx as any, { question: "Freeform?" });
      expect(inputPrompt).toContain("Freeform?");
      expect(result).toEqual({ kind: "freeform", text: "typed answer" });
   });

   test("with no options and blank input, returns null (empty freeform is not an answer)", async () => {
      const ctx = {
         hasUI: true,
         ui: {
            setWorkingMessage() {},
            async input() {
               return "   ";
            },
         },
      };
      const result = await askUser(ctx as any, { question: "Freeform?" });
      expect(result).toBeNull();
   });
});

describe("cancel-reason plumbing (local fork)", () => {
   test("isCancel recognizes the cancel sentinel and rejects plain responses", () => {
      expect(isCancel({ __cancel: true, reason: "user" })).toBe(true);
      expect(isCancel({ __cancel: true, reason: "timeout" })).toBe(true);
      expect(isCancel({ __cancel: true, reason: "signal" })).toBe(true);
      expect(isCancel({ kind: "freeform", text: "hi" })).toBe(false);
      expect(isCancel(null)).toBe(false);
      expect(isCancel(undefined)).toBe(false);
      expect(isCancel("nope")).toBe(false);
   });

   test("a cancel sentinel returned by the UI propagates through askUser and is detectable", async () => {
      const capture: CustomCapture = { options: "unset", factoryCalled: false };
      const ctx = fakeCtx({ __cancel: true, reason: "user" }, capture);

      const result = await askUser(ctx, { question: "Pick", options: ["A", "B"] });
      expect(isCancel(result)).toBe(true);
      expect((result as any).reason).toBe("user");
   });

   test("an abort signal resolves the call as a 'signal' cancel", async () => {
      const controller = new AbortController();
      const ctx = {
         hasUI: true,
         ui: {
            setWorkingMessage() {},
            notify() {},
            async custom(factory: any) {
               // askUser's factory registers the abort listener BEFORE it constructs the real
               // AskComponent; that construction needs the full pi-tui/theme mock harness, so we
               // let it throw and swallow it here — the abort listener is already wired by then.
               return await new Promise((resolve) => {
                  try {
                     factory(
                        { requestRender() {}, terminal: { rows: 24 } },
                        {},
                        {},
                        (r: unknown) => resolve(r),
                     );
                  } catch {
                     // AskComponent construction failed under the minimal fake ui — expected.
                  }
                  controller.abort();
               });
            },
         },
      };

      const result = await askUser(ctx as any, {
         question: "Pick",
         options: ["A", "B"],
         signal: controller.signal,
      });
      expect(isCancel(result)).toBe(true);
      expect((result as any).reason).toBe("signal");
   });
});
