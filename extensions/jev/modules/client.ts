/**
 * Minimal Jev (TypeSafe System One) client for the fusion-harness jev extension.
 *
 * Protocol vendored from disler/ten-levels-of-jev (MIT): one POST of { model, state, questions }
 * to a decisions endpoint; typed answers keyed by your question IDs come back. Questions are
 * noul (probability of yes), choice (one of your declared options, never an invented one), or
 * score (a position on levels you describe).
 *
 * Backends: "openrouter" (live, OPENROUTER_API_KEY) and "mock" (deterministic, offline, safe
 * defaults: every guard question judges the subject harmless, compact timing stays silent).
 */

export type State = string | Record<string, unknown> | unknown[];
export type Instructions = string | Record<string, unknown>;

export interface NoulQuestion {
	type: "noul";
	instructions: Instructions;
	criteria?: { true?: string; false?: string };
}
export interface ChoiceQuestion {
	type: "choice";
	instructions: Instructions;
	criteria: Record<string, string | null>;
}
export interface ScoreQuestion {
	type: "score";
	instructions: Instructions;
	criteria: string[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
	type: "noul";
	/** Probability the answer is yes. 0 = strong no, 1 = strong yes. */
	noul: number;
}
export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}
export interface ScoreAnswer {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevCallResult {
	answers: Record<string, Answer>;
	usage: { input_tokens: number; output_tokens: number; cost?: unknown };
	model: string;
	ms: number;
	/** USD when the provider reported a usable cost. */
	costUsd: number | null;
}

export const noul = (instructions: Instructions, criteria?: { true?: string; false?: string }): NoulQuestion => ({
	type: "noul",
	instructions,
	...(criteria ? { criteria } : {}),
});
export const choice = (instructions: Instructions, criteria: Record<string, string | null>): ChoiceQuestion => ({
	type: "choice",
	instructions,
	criteria,
});
export const score = (instructions: Instructions, criteria: string[]): ScoreQuestion => ({ type: "score", instructions, criteria });

export class JevError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevError";
	}
}

export const LIMITS = { MAX_CHOICE_OPTIONS: 255, MIN_SCORE_LEVELS: 2, MAX_SCORE_LEVELS: 10 } as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Client-side validation of the question block, before any transport. */
export function validateQuestions(questions: unknown): asserts questions is Questions {
	if (!isRecord(questions) || Object.keys(questions).length === 0) throw new JevError("Questions must be a nonempty object.");
	for (const [id, q] of Object.entries(questions)) {
		if (!isRecord(q)) throw new JevError(`Question "${id}" must be an object.`);
		if (q.type !== "noul" && q.type !== "choice" && q.type !== "score") throw new JevError(`Question "${id}" has a missing or unknown type.`);
		if (typeof q.instructions === "string" ? !q.instructions.trim() : !isRecord(q.instructions)) {
			throw new JevError(`Question "${id}" needs nonblank string or object instructions.`);
		}
		if (q.type === "choice") {
			if (!isRecord(q.criteria)) throw new JevError(`Choice "${id}" criteria must be an object.`);
			const options = Object.keys(q.criteria);
			if (options.length === 0) throw new JevError(`Choice "${id}" has no options.`);
			if (options.length > LIMITS.MAX_CHOICE_OPTIONS) throw new JevError(`Choice "${id}" has ${options.length} options; max ${LIMITS.MAX_CHOICE_OPTIONS}.`);
			if (Object.values(q.criteria).some((v) => v !== null && typeof v !== "string")) {
				throw new JevError(`Choice "${id}" descriptions must be strings or null.`);
			}
		}
		if (q.type === "score") {
			if (!Array.isArray(q.criteria)) throw new JevError(`Score "${id}" criteria must be an array.`);
			if (q.criteria.length < LIMITS.MIN_SCORE_LEVELS || q.criteria.length > LIMITS.MAX_SCORE_LEVELS) {
				throw new JevError(`Score "${id}" must have ${LIMITS.MIN_SCORE_LEVELS}-${LIMITS.MAX_SCORE_LEVELS} levels; got ${q.criteria.length}.`);
			}
			if (q.criteria.some((l) => typeof l !== "string" || !l.trim())) throw new JevError(`Score "${id}" levels must be nonblank strings.`);
		}
	}
}

const isUnit = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

/** Strict-enough live contract: envelope, one answer per question, matching types. */
function validateResponse(response: unknown, questions: Questions): asserts response is { model: string; answers: Record<string, Answer>; usage: JevCallResult["usage"] } {
	if (!isRecord(response) || typeof response.model !== "string" || !response.model.trim() || !isRecord(response.answers)) {
		throw new JevError("Invalid response envelope: expected model and answers.");
	}
	if (!isRecord(response.usage) || typeof response.usage.input_tokens !== "number" || typeof response.usage.output_tokens !== "number") {
		throw new JevError("Invalid response usage.");
	}
	for (const [id, q] of Object.entries(questions)) {
		const a = response.answers[id];
		if (!isRecord(a) || a.type !== q.type) throw new JevError(`Missing or mismatched answer: ${id}`);
		if (q.type === "noul" && !isUnit(a.noul)) throw new JevError(`Invalid noul: ${id}`);
		if (q.type !== "noul" && !isUnit(a.confidence)) throw new JevError(`Invalid confidence: ${id}`);
		if (q.type === "choice" && (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice))) {
			throw new JevError(`Undeclared choice returned: ${id}`);
		}
		if (q.type === "score" && (typeof a.score !== "number" || a.score < 0 || a.score > q.criteria.length - 1)) {
			throw new JevError(`Score out of range: ${id}`);
		}
	}
}

/**
 * Deterministic offline answers. SAFE defaults: guards judge the subject harmless, the compact
 * timing questions report "mid operation" (advisory stays silent), the cut point picks "none".
 */
export function mockAnswers(questions: Questions): Record<string, Answer> {
	const out: Record<string, Answer> = {};
	for (const [id, q] of Object.entries(questions)) {
		if (q.type === "noul") {
			const p = /destructive|injection|secret|switched|boundary/i.test(id) ? 0.05 : /mid_operation/i.test(id) ? 0.9 : 0.9;
			out[id] = { type: "noul", noul: p };
		} else if (q.type === "choice") {
			const keys = Object.keys(q.criteria);
			const pick = keys.includes("none") ? "none" : keys.includes("read_only") ? "read_only" : keys.includes("source_code") ? "source_code" : keys[0]!;
			const rest = keys.filter((k) => k !== pick);
			const probabilities: Record<string, number> = { [pick]: 0.9 };
			for (const k of rest) probabilities[k] = rest.length ? 0.1 / rest.length : 0;
			out[id] = { type: "choice", choice: pick, probabilities, confidence: 0.9 };
		} else {
			const value = /needs_history/i.test(id) ? 0.2 : (q.criteria.length - 1) / 2;
			const probabilities: Record<string, number> = {};
			const peak = String(Math.round(value));
			for (let i = 0; i < q.criteria.length; i++) probabilities[String(i)] = String(i) === peak ? 0.9 : 0.1 / Math.max(1, q.criteria.length - 1);
			const legend: Record<string, string> = {};
			q.criteria.forEach((text, i) => (legend[String(i)] = text));
			out[id] = { type: "score", score: value, legend, probabilities, confidence: 0.9 };
		}
	}
	return out;
}

export type JevBackend = "openrouter" | "mock";

export interface JevClientOptions {
	backend?: JevBackend;
	apiKey?: string;
	/** Pin a versioned model id; default typesafe/jev-1.13 (the moving alias is ~typesafe/jev-latest). */
	model?: string;
	timeoutMs?: number;
}

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "typesafe/jev-1.13";
const RETRY_STATUSES = new Set([429, 502, 503, 529]);
const MAX_ATTEMPTS = 3;

export class JevClient {
	readonly backend: JevBackend | "unavailable";
	private readonly apiKey?: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	/** Count of systemOne calls, for the /jev cost story. */
	calls = 0;

	constructor(opts: JevClientOptions = {}) {
		this.model = opts.model?.trim() || DEFAULT_MODEL;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		if (opts.backend === "mock") {
			this.backend = "mock";
			return;
		}
		this.apiKey = (opts.apiKey ?? process.env.OPENROUTER_API_KEY)?.trim();
		this.backend = this.apiKey ? "openrouter" : "unavailable";
	}

	get available(): boolean {
		return this.backend !== "unavailable";
	}

	async systemOne(state: State, questions: Questions, opts: { signal?: AbortSignal } = {}): Promise<JevCallResult> {
		opts.signal?.throwIfAborted();
		validateQuestions(questions);
		if (this.backend === "unavailable") throw new JevError("No Jev credentials: set OPENROUTER_API_KEY or use backend mock.");
		this.calls++;
		const started = performance.now();
		if (this.backend === "mock") {
			return {
				answers: mockAnswers(questions),
				usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
				model: "jev-mock",
				ms: Math.round(performance.now() - started),
				costUsd: 0,
			};
		}
		const body = JSON.stringify({ model: this.model, state, questions });
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(new DOMException("Jev request timed out.", "TimeoutError")), this.timeoutMs);
		const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
		try {
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				signal.throwIfAborted();
				const res = await fetch(ENDPOINT, {
					method: "POST",
					headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
					body,
					signal,
					redirect: "error",
				});
				signal.throwIfAborted();
				if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
					await res.body?.cancel();
					await new Promise((resolve, reject) => {
						const t = setTimeout(resolve, Math.min(8000, 500 * 2 ** (attempt - 1)));
						signal.addEventListener("abort", () => {
							clearTimeout(t);
							reject(signal.reason);
						}, { once: true });
					});
					continue;
				}
				if (!res.ok) {
					await res.body?.cancel();
					throw new JevError(`openrouter HTTP ${res.status}.${res.status === 401 ? " Check OPENROUTER_API_KEY." : res.status === 402 ? " Check account credits." : ""}`);
				}
				const response: unknown = await res.json();
				validateResponse(response, questions);
				const cost = response.usage.cost;
				return {
					answers: response.answers,
					usage: response.usage,
					model: response.model,
					ms: Math.round(performance.now() - started),
					costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
				};
			}
			throw new JevError("openrouter retries exhausted");
		} finally {
			clearTimeout(timer);
		}
	}
}
