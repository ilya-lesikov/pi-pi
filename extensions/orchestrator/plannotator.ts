import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Orchestrator } from "./orchestrator.js";

export type PlannotatorOpenOutcome = "opened" | "timeout" | "not-handled";

export function openPlannotator(
  pi: ExtensionAPI,
  action: string,
  payload: Record<string, unknown>,
): Promise<{ opened: boolean; reviewId: string | null; outcome: PlannotatorOpenOutcome }> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let handled = false;
    const timer = setTimeout(() => {
      if (!handled) resolve({ opened: false, reviewId: null, outcome: "timeout" });
    }, 30000);
    pi.events.emit("plannotator:request", {
      requestId,
      action,
      payload,
      respond: (response: any) => {
        handled = true;
        clearTimeout(timer);
        const reviewId = response?.result?.reviewId ?? null;
        const opened = response.status === "handled";
        resolve({ opened, reviewId, outcome: opened ? "opened" : "not-handled" });
      },
    });
  });
}

export interface AnnotateReviewResult {
  feedback: string;
  exit?: boolean;
  approved?: boolean;
}

const PLANNOTATOR_RESULT_TIMEOUT_MS = 30 * 60 * 1000;

// The `annotate` action is a SYNCHRONOUS request/response: its handler awaits the
// full browser review and only calls respond() with the PlannotatorAnnotationResult
// once the reviewer approves / submits feedback / closes. That can take minutes, so
// unlike openPlannotator this helper does NOT wrap respond in a short (30s) ack
// timer — the result arrives via the (late) respond callback, not a
// plannotator:review-result event, so waitForPlannotatorResult must NOT be used
// here. A long review-length timeout still bounds the pathological case where
// pi-plannotator is not installed/enabled (no listener ever calls respond), so the
// /pp menu can't hang forever — it resolves as not-opened and the caller recovers.
export function openAnnotateReview(
  pi: ExtensionAPI,
  payload: Record<string, unknown>,
  timeoutMs: number = PLANNOTATOR_RESULT_TIMEOUT_MS,
): Promise<{ opened: boolean; result: AnnotateReviewResult | null }> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ opened: false, result: null });
      }
    }, timeoutMs);
    pi.events.emit("plannotator:request", {
      requestId,
      action: "annotate",
      payload,
      respond: (response: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const opened = response?.status === "handled";
        resolve({ opened, result: opened ? (response?.result ?? null) : null });
      },
    });
  });
}

export function cancelPendingPlannotatorWait(orchestrator: Orchestrator): void {
  if (orchestrator.plannotatorTimer) {
    clearTimeout(orchestrator.plannotatorTimer);
    orchestrator.plannotatorTimer = null;
  }
  if (orchestrator.plannotatorUnsub) {
    orchestrator.plannotatorUnsub();
    orchestrator.plannotatorUnsub = null;
  }
  if (orchestrator.plannotatorReject) {
    orchestrator.plannotatorReject(new Error("Plannotator wait cancelled"));
    orchestrator.plannotatorReject = null;
  }
}

export function waitForPlannotatorResult(
  orchestrator: Orchestrator,
  reviewId: string | null,
  timeoutMs: number | null = PLANNOTATOR_RESULT_TIMEOUT_MS,
): Promise<{ approved: boolean; feedback?: string; error?: string }> {
  cancelPendingPlannotatorWait(orchestrator);
  const pi = orchestrator.pi;
  return new Promise((resolve, reject) => {
    orchestrator.plannotatorReject = reject;
    const unsub = pi.events.on("plannotator:review-result", (data: any) => {
      if (reviewId && data?.reviewId && data.reviewId !== reviewId) return;
      cleanup();
      resolve({ approved: !!data?.approved, feedback: data?.feedback, error: data?.error });
    });
    orchestrator.plannotatorUnsub = unsub;
    function cleanup() {
      unsub();
      orchestrator.plannotatorUnsub = null;
      orchestrator.plannotatorReject = null;
      if (orchestrator.plannotatorTimer) {
        clearTimeout(orchestrator.plannotatorTimer);
        orchestrator.plannotatorTimer = null;
      }
    }
    if (timeoutMs !== null) {
      orchestrator.plannotatorTimer = setTimeout(() => {
        cleanup();
        reject(new Error("Plannotator review timed out"));
      }, timeoutMs);
    }
  });
}
