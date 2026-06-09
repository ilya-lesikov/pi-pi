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
    pi.events.emit("plannotator:request", {
      requestId,
      action,
      payload,
      respond: (response: any) => {
        handled = true;
        const reviewId = response?.result?.reviewId ?? null;
        resolve({ opened: response.status === "handled", reviewId });
      },
    });
    setTimeout(() => {
      if (!handled) resolve({ opened: false, reviewId: null });
    }, 30000);
  });
}

export function cancelPendingPlannotatorWait(orchestrator: Orchestrator): void {
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
): Promise<{ approved: boolean; feedback?: string }> {
  cancelPendingPlannotatorWait(orchestrator);
  const pi = orchestrator.pi;
  return new Promise((resolve, reject) => {
    orchestrator.plannotatorReject = reject;
    const unsub = pi.events.on("plannotator:review-result", (data: any) => {
      if (reviewId && data?.reviewId && data.reviewId !== reviewId) return;
      unsub();
      orchestrator.plannotatorUnsub = null;
      orchestrator.plannotatorReject = null;
      resolve({ approved: !!data?.approved, feedback: data?.feedback });
    });
    orchestrator.plannotatorUnsub = unsub;
  });
}
