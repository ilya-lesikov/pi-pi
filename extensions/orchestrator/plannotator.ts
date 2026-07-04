import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Orchestrator } from "./orchestrator.js";

export function openPlannotator(
  pi: ExtensionAPI,
  action: string,
  payload: Record<string, unknown>,
): Promise<{ opened: boolean; reviewId: string | null }> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let handled = false;
    const timer = setTimeout(() => {
      if (!handled) resolve({ opened: false, reviewId: null });
    }, 30000);
    pi.events.emit("plannotator:request", {
      requestId,
      action,
      payload,
      respond: (response: any) => {
        handled = true;
        clearTimeout(timer);
        const reviewId = response?.result?.reviewId ?? null;
        resolve({ opened: response.status === "handled", reviewId });
      },
    });
  });
}

const PLANNOTATOR_RESULT_TIMEOUT_MS = 30 * 60 * 1000;

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
