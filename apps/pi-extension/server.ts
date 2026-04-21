/**
 * Node-compatible servers for Plannotator Pi extension.
 *
 * Pi loads extensions via jiti (Node.js), so we can't use Bun.serve().
 * These are lightweight node:http servers implementing just the routes
 * each UI needs — plan review, code review, and markdown annotation.
 */

export type {
	DiffOption,
	DiffType,
	GitContext,
} from "./generated/review-core.js";
export {
	type AnnotateServerResult,
	startAnnotateServer,
} from "./server/serverAnnotate.js";
export {
	type PlanServerResult,
	startPlanReviewServer,
} from "./server/serverPlan.js";
export {
	getGitContext,
	reviewRuntime,
	type ReviewServerResult,
	runGitDiff,
	startReviewServer,
} from "./server/serverReview.js";
