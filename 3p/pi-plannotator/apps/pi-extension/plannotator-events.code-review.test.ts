import { describe, expect, test, mock, beforeEach } from "bun:test";

type DecisionListener = (result: { approved: boolean; feedback?: string; agentSwitch?: string }) => void;

let sessionBehavior: {
	throwOnStart?: Error;
	decision?: { approved: boolean; feedback?: string };
	resolveWaitImmediately?: boolean;
} = {};
let startCalls = 0;
let decisionListeners: DecisionListener[] = [];

mock.module("./plannotator-browser.js", () => ({
	getLastAssistantMessageText: () => "",
	getStartupErrorMessage: (err: unknown) => (err instanceof Error ? err.message : "Unknown error"),
	hasPlanBrowserHtml: () => true,
	hasReviewBrowserHtml: () => true,
	shouldUseLocalPrCheckout: (options: { useLocal?: boolean }) => options.useLocal !== false,
	openArchiveBrowserAction: async () => ({ opened: false }),
	openCodeReview: async () => ({ approved: false }),
	openPlanReviewBrowser: async () => ({ approved: false }),
	openLastMessageAnnotation: async () => ({ feedback: "" }),
	openMarkdownAnnotation: async () => ({ feedback: "" }),
	startCodeReviewBrowserSession: async () => {
		startCalls += 1;
		if (sessionBehavior.throwOnStart) throw sessionBehavior.throwOnStart;
		return {
			url: "http://localhost:0",
			reviewId: "server-review-id",
			onDecision: (listener: DecisionListener) => {
				decisionListeners.push(listener);
				return () => {};
			},
			waitForDecision: () =>
				new Promise((resolve) => {
					if (sessionBehavior.resolveWaitImmediately && sessionBehavior.decision) {
						resolve(sessionBehavior.decision as any);
					}
				}),
			stop: () => {},
		};
	},
	startLastMessageAnnotationSession: async () => ({}),
	startMarkdownAnnotationSession: async () => ({}),
	startPlanReviewBrowserSession: async () => ({}),
}));

const { registerPlannotatorEventListeners, PLANNOTATOR_REQUEST_CHANNEL, PLANNOTATOR_REVIEW_RESULT_CHANNEL } =
	await import("./plannotator-events.js");

interface FakePi {
	on: (event: string, handler: (event: any, ctx: any) => void | Promise<void>) => void;
	events: {
		on: (channel: string, handler: (data: any) => void) => () => void;
		emit: (channel: string, data: any) => void;
		_handlers: Record<string, Array<(data: any) => void>>;
		_sessionStart?: (event: any, ctx: any) => void | Promise<void>;
	};
}

function makeFakePi(): FakePi {
	const handlers: Record<string, Array<(data: any) => void>> = {};
	const pi: FakePi = {
		on: (event, handler) => {
			if (event === "session_start") pi.events._sessionStart = handler;
		},
		events: {
			_handlers: handlers,
			on: (channel, handler) => {
				(handlers[channel] ??= []).push(handler);
				return () => {
					handlers[channel] = (handlers[channel] ?? []).filter((h) => h !== handler);
				};
			},
			emit: (channel, data) => {
				for (const h of handlers[channel] ?? []) h(data);
			},
		},
	};
	return pi;
}

async function emitCodeReviewRequest(pi: FakePi): Promise<{
	response: any;
	results: any[];
}> {
	const results: any[] = [];
	pi.events.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, (data) => results.push(data));

	let response: any;
	pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
		requestId: "req-1",
		action: "code-review",
		payload: { cwd: "/tmp/repo" },
		respond: (r: any) => {
			response = r;
		},
	});
	// Let the synchronous respond + microtasks settle.
	await new Promise((r) => setTimeout(r, 10));
	return { response, results };
}

beforeEach(() => {
	sessionBehavior = {};
	startCalls = 0;
	decisionListeners = [];
});

describe("code-review two-phase handler", () => {
	test("acks pending with a reviewId synchronously, before any heavy prep resolves", async () => {
		const pi = makeFakePi();
		registerPlannotatorEventListeners(pi as any);
		await pi.events._sessionStart?.({}, { cwd: "/tmp/repo", hasUI: true });

		let respondedSynchronously = false;
		let ackReviewId: string | undefined;
		pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
			requestId: "req-1",
			action: "code-review",
			payload: { cwd: "/tmp/repo" },
			respond: (r: any) => {
				respondedSynchronously = true;
				ackReviewId = r?.result?.reviewId;
				expect(r.status).toBe("handled");
				expect(r.result.status).toBe("pending");
			},
		});

		// The ack must fire in the same tick as the request handler's first
		// awaited boundary — before startCodeReviewBrowserSession is invoked.
		expect(respondedSynchronously).toBe(true);
		expect(typeof ackReviewId).toBe("string");
		expect(ackReviewId!.length).toBeGreaterThan(0);
	});

	test("emits a review-result on the pending reviewId when the user decides", async () => {
		const pi = makeFakePi();
		registerPlannotatorEventListeners(pi as any);
		await pi.events._sessionStart?.({}, { cwd: "/tmp/repo", hasUI: true });

		const { response, results } = await emitCodeReviewRequest(pi);
		const reviewId = response.result.reviewId;

		expect(startCalls).toBe(1);
		expect(decisionListeners.length).toBe(1);

		decisionListeners[0]({ approved: true, feedback: "looks good" });

		expect(results.length).toBe(1);
		expect(results[0].reviewId).toBe(reviewId);
		expect(results[0].approved).toBe(true);
		expect(results[0].feedback).toBe("looks good");
		expect(results[0].error).toBeUndefined();
	});

	test("emits a review-result with an error when startup/prep fails after the pending ack", async () => {
		sessionBehavior = { throwOnStart: new Error("worktree prep failed") };
		const pi = makeFakePi();
		registerPlannotatorEventListeners(pi as any);
		await pi.events._sessionStart?.({}, { cwd: "/tmp/repo", hasUI: true });

		const { response, results } = await emitCodeReviewRequest(pi);
		const reviewId = response.result.reviewId;

		expect(response.result.status).toBe("pending");
		expect(results.length).toBe(1);
		expect(results[0].reviewId).toBe(reviewId);
		expect(results[0].approved).toBe(false);
		expect(results[0].error).toBe("worktree prep failed");
	});
});
