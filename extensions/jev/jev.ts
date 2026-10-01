/**
 * jev — cheap typed decisions (TypeSafe System One) inside the fusion-harness + self-compact stack.
 *
 *   pi -e extensions/fusion-harness/fusion-harness.ts \
 *      -e extensions/jev/jev.ts \
 *      -e <self-compact>/self-compact.ts [--jev-backend openrouter|mock] [--jev-model typesafe/jev-1.13]
 *
 * LOAD ORDER MATTERS: after fusion-harness, BEFORE self-compact. Jev's session_before_compact
 * handler folds its cut-point pick into event.customInstructions, which self-compact reads when
 * it builds the summary. Jev has no footer, so self-compact's gauge still owns the bottom row.
 *
 * Three features (each disableable):
 *   --jev-guard  (default on)  tool_call: bash gate (irreversible/destructive blocks) and a
 *                              credential check on write/edit content. tool_result: an injection
 *                              screen banners read/bash output that carries instructions.
 *   --jev-reads  (default on)  ask_jev_file_bool / _choice / _score tools: a judgment ABOUT a
 *                              file without the file entering the host's context.
 *   --jev-timing (default on)  inside self-compact's warning band (from --compact-at/--compact-buffer),
 *                              four Jev questions per turn judge checkpoint quality; a clean
 *                              checkpoint surfaces a transient [jev · checkpoint] advisory that
 *                              names self_compact. At compaction, one Choice picks which turn the
 *                              live work starts from and folds it into the summary instructions.
 *
 * Every hook fails OPEN: a Jev error allows the call and warns once. Guards never run while
 * context is past the forced line — self-compact's lock owns that state, so the call would be
 * blocked anyway. Children spawned by fusion-harness use --no-extensions and never see Jev.
 *
 * Protocol vendored from disler/ten-levels-of-jev (MIT). Live calls hit OpenRouter's decisions
 * endpoint (~300 ms, fractions of a cent); --jev-backend mock is deterministic and offline.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { JevClient, type Questions, type State } from "./modules/client.ts";
import {
	advisoryMessage,
	askFileBool,
	askFileChoice,
	askFileScore,
	BASH_QUESTIONS,
	BLOCK_NOTICE,
	checkpointVerdict,
	COMPACT_QUESTIONS,
	cutPointInstructions,
	cutPointQuestion,
	FileStateError,
	gateBash,
	gateWrite,
	screenResult,
	SCREEN_MAX_CHARS,
	SCREEN_QUESTIONS,
	WRITE_MAX_CHARS,
	WRITE_QUESTIONS,
	type BashGateAnswers,
	type CompactAnswers,
	type GateDecision,
	type TurnSummary,
} from "./modules/decisions.ts";

const GUIDANCE_TYPE = "jev-guidance";
const ENTRY_TYPE = "jev-decision";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const textOf = (m: any): string =>
	(Array.isArray(m?.content) ? m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : String(m?.content ?? "")).trim();

/** Percent spec ("20%"), token count ("120000", "120k"), or fallback percent of the window. */
function specTokens(spec: string | undefined, fallbackPct: number, window: number): number {
	if (!spec) return (fallbackPct / 100) * window;
	const trimmed = spec.trim();
	const pct = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
	if (pct) return (Number(pct[1]) / 100) * window;
	const k = /^(\d+(?:\.\d+)?)k$/i.exec(trimmed);
	if (k) return Number(k[1]) * 1000;
	const n = Number(trimmed);
	return Number.isFinite(n) && n > 0 ? n : (fallbackPct / 100) * window;
}

export default function jevExtension(pi: ExtensionAPI) {
	pi.registerFlag("jev", { type: "string", description: "jev extension: off disables everything (default on).", });
	pi.registerFlag("jev-backend", { type: "string", description: "Jev backend: openrouter (default, needs OPENROUTER_API_KEY) or mock (offline, safe canned answers)." });
	pi.registerFlag("jev-model", { type: "string", description: "Jev model id on the decisions endpoint. Default typesafe/jev-1.13." });
	pi.registerFlag("jev-guard", { type: "string", description: "Bash/write guardrails: off disables (default on)." });
	pi.registerFlag("jev-reads", { type: "string", description: "ask_jev_file_* cheap-read tools: off disables (default on)." });
	pi.registerFlag("jev-timing", { type: "string", description: "Checkpoint-quality advisories + cut-point pick for self-compact: off disables (default on)." });

	const flag = (name: string): string | undefined => {
		const v = pi.getFlag(name);
		return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
	};
	const on = (name: string): boolean => flag(name) !== "off";

	let client: JevClient | undefined;
	let enabled = false;
	let guardOn = true;
	let readsOn = true;
	let timingOn = true;
	let hasSelfCompact = false;
	let warned = new Set<string>();
	const stats = { calls: 0, costUsd: 0, blocked: 0, screened: 0, advisories: 0 };

	// Timing state
	const userMessages: string[] = [];
	let lastSummary = "";
	let advisory: string | null = null;
	const bashCache = new Map<string, GateDecision>();

	function warnOnce(ctx: ExtensionContext, key: string, message: string) {
		if (warned.has(key)) return;
		warned.add(key);
		if (ctx.hasUI) ctx.ui.notify(`jev: ${message}`, "warning");
	}

	/** One Jev call with reporting. Throws on transport/contract errors; callers fail open. */
	async function decide(source: string, state: State, questions: Questions, extra: Record<string, unknown> = {}) {
		const result = await client!.systemOne(state, questions);
		stats.calls++;
		if (result.costUsd !== null) stats.costUsd += result.costUsd;
		try {
			pi.appendEntry(ENTRY_TYPE, { source, state, answers: result.answers, model: result.model, ms: result.ms, costUsd: result.costUsd, ...extra });
		} catch {
			/* entries are optional */
		}
		return result;
	}

	function usage(ctx: ExtensionContext): { tokens: number; window: number; pct: number } {
		const u = ctx.getContextUsage?.();
		const window = u?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const tokens = u?.tokens ?? 0;
		const pct = u?.percent ?? (window > 0 ? (tokens / window) * 100 : 0);
		return { tokens, window, pct };
	}

	/** self-compact's warning band, read from ITS flags (fallback: the shipped 20% / +10% defaults). */
	function band(ctx: ExtensionContext): { warn: number; forced: number } {
		const window = ctx.model?.contextWindow ?? usage(ctx).window;
		const warn = specTokens(flag("compact-at"), 20, window);
		const forced = warn + specTokens(flag("compact-buffer"), 10, window);
		return { warn, forced };
	}

	// ---------------------------------------------------------------- events

	pi.on("session_start", async (_ev, ctx) => {
		userMessages.length = 0;
		lastSummary = "";
		advisory = null;
		bashCache.clear();
		warned = new Set();
		enabled = flag("jev") !== "off";
		guardOn = on("jev-guard");
		readsOn = on("jev-reads");
		timingOn = on("jev-timing");
		hasSelfCompact = pi.getAllTools?.().some((t) => t.name === "self_compact") ?? false;
		if (!enabled) return;
		const backendFlag = flag("jev-backend");
		client = new JevClient({
			backend: backendFlag === "mock" ? "mock" : undefined,
			model: flag("jev-model"),
		});
		if (!client.available) {
			enabled = false;
			warnOnce(ctx, "no-key", "no OPENROUTER_API_KEY and no --jev-backend mock — Jev features disabled for this session.");
		}
	});

	pi.on("session_shutdown", async () => {
		client = undefined;
	});

	pi.on("model_select", async () => {
		advisory = null;
	});

	pi.on("message_end", async (event, _ctx) => {
		if (event.message?.role === "user") userMessages.push(textOf(event.message));
	});

	pi.on("session_compact", async (event: any, _ctx) => {
		lastSummary = event.compactionEntry?.summary ?? lastSummary;
		advisory = null;
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!enabled) return undefined;
		const line = hasSelfCompact
			? "\n\njev: a fast decision model supports this session. A transient [jev · checkpoint] message means context is past the warning line and the work is at a clean boundary: write your note_to_self and call self_compact at the next natural stop. ask_jev_file_bool / ask_jev_file_choice / ask_jev_file_score answer a judgment about a file WITHOUT the file entering your context; use them when you need to know something about a file, and the read tool when you need the code itself to edit or quote."
			: "\n\njev: a fast decision model supports this session. A transient [jev · checkpoint] message means context is high and the work is at a clean boundary: a good moment to compact. ask_jev_file_bool / ask_jev_file_choice / ask_jev_file_score answer a judgment about a file WITHOUT the file entering your context; use them when you need to know something about a file, and the read tool when you need the code itself to edit or quote.";
		return { systemPrompt: event.systemPrompt + line };
	});

	// Timing: evaluate checkpoint quality once per turn, only inside the warning band.
	pi.on("turn_end", async (event: any, ctx) => {
		if (!enabled || !timingOn || advisory) return;
		try {
			const u = usage(ctx);
			const { warn, forced } = band(ctx);
			if (u.tokens < warn || u.tokens >= forced) return; // below: too early; above: self-compact's lock owns it
			if (userMessages.length < 2) return;
			const tools = (event.toolResults ?? []).map((r: any) => r?.toolName ?? r?.name).filter(Boolean);
			const state: State = {
				current_request: clip(userMessages.at(-1) ?? "", 600),
				previous_work:
					[...userMessages.slice(0, -1).map((m) => clip(m, 200)), lastSummary ? `Summary so far: ${clip(lastSummary, 400)}` : ""].filter(Boolean).join("\n") ||
					"(nothing before this request)",
				recent_turn: clip(textOf(event.message) || `(tool calls only: ${tools.join(", ") || "none"})`, 600),
				tools_this_turn: tools,
			};
			const { answers } = await decide("turn_end", state, COMPACT_QUESTIONS, { tokens: u.tokens, pct: u.pct });
			const verdict = checkpointVerdict(answers as unknown as CompactAnswers);
			if (verdict.checkpoint) {
				advisory = advisoryMessage(verdict, u.pct, hasSelfCompact ? "self_compact" : "/compact");
				stats.advisories++;
			}
		} catch (error) {
			warnOnce(ctx, "timing", `checkpoint evaluation failed (${error instanceof Error ? error.message : String(error)}); timing advisories keep failing open.`);
		}
	});

	// The advisory rides the next model call as a transient message; never persisted.
	pi.on("context", async (event, _ctx) => {
		const messages = event.messages.filter((m: any) => !(m.role === "custom" && m.customType === GUIDANCE_TYPE));
		if (enabled && advisory) {
			messages.push({ role: "custom" as const, customType: GUIDANCE_TYPE, content: advisory, display: false, timestamp: Date.now() });
		}
		return { messages };
	});

	// Guard: bash gate + write credential check. Past the forced line self-compact blocks
	// everything anyway, so the Jev call would be wasted — skip it there.
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || !guardOn) return undefined;
		const name = event.toolName;
		if (name !== "bash" && name !== "write" && name !== "edit") return undefined;
		try {
			const u = usage(ctx);
			if (u.tokens >= band(ctx).forced) return undefined;
			if (name === "bash") {
				const command = String((event.input as any)?.command ?? "");
				if (!command.trim()) return undefined;
				let d = bashCache.get(command);
				if (!d) {
					const { answers } = await decide("tool_call bash", { command, cwd: ctx.cwd }, BASH_QUESTIONS);
					d = gateBash(answers as unknown as BashGateAnswers);
					bashCache.set(command, d);
				}
				if (d.block) {
					stats.blocked++;
					if (ctx.hasUI) ctx.ui.notify(`jev-guard blocked bash: ${d.reason}`, "warning");
					return { block: true, reason: `jev-guard blocked this command: ${d.reason}. ${BLOCK_NOTICE}` };
				}
				return undefined;
			}
			const input = event.input as any;
			let content = String(input?.content ?? input?.newText ?? input?.new_string ?? "");
			if (!content && Array.isArray(input?.edits)) content = input.edits.map((e: any) => String(e?.newText ?? "")).join("\n");
			if (!content.trim()) return undefined;
			const trimmed = content.length > WRITE_MAX_CHARS ? `${content.slice(0, WRITE_MAX_CHARS)}\n…` : content;
			const { answers } = await decide(`tool_call ${name}`, { path: String(input?.path ?? ""), content: trimmed }, WRITE_QUESTIONS);
			const d = gateWrite(answers as any);
			if (d.block) {
				stats.blocked++;
				if (ctx.hasUI) ctx.ui.notify(`jev-guard blocked ${name}: ${d.reason}`, "warning");
				return { block: true, reason: `jev-guard blocked this ${name}: ${d.reason}. ${BLOCK_NOTICE}` };
			}
		} catch (error) {
			warnOnce(ctx, "guard", `guard call failed (${error instanceof Error ? error.message : String(error)}); failing open.`);
		}
		return undefined;
	});

	// Guard: injection screen on read/bash output. Bannered, not removed — the agent still sees it as data.
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled || !guardOn) return undefined;
		if (event.toolName !== "read" && event.toolName !== "bash") return undefined;
		try {
			const text = Array.isArray(event.content)
				? event.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
				: "";
			const trimmed = text.length > SCREEN_MAX_CHARS ? text.slice(0, SCREEN_MAX_CHARS) : text;
			if (!trimmed.trim()) return undefined;
			const { answers } = await decide(`tool_result ${event.toolName}`, { tool: event.toolName, content: trimmed }, SCREEN_QUESTIONS);
			const d = screenResult(answers as any);
			if (d.flag && d.banner) {
				stats.screened++;
				if (ctx.hasUI) ctx.ui.notify(`jev-guard: injected instructions flagged in ${event.toolName} output (${d.noul.toFixed(2)})`, "warning");
				return { content: [{ type: "text" as const, text: `${d.banner}\n\n${text}` }] };
			}
		} catch (error) {
			warnOnce(ctx, "screen", `result screen failed (${error instanceof Error ? error.message : String(error)}); failing open.`);
		}
		return undefined;
	});

	// Timing: the cut point. Runs BEFORE self-compact's handler (load order), which reads
	// event.customInstructions into the summary it generates. Never returns a result itself.
	pi.on("session_before_compact", async (event: any, ctx) => {
		if (!enabled || !timingOn) return undefined;
		if (event.reason !== "manual") return undefined; // self-compact cancels those; don't spend a call
		try {
			const turns: TurnSummary[] = userMessages.map((m, i) => ({ index: i, request: clip(m, 120) }));
			if (turns.length < 2) return undefined;
			const { answers } = await decide("session_before_compact", { turns }, cutPointQuestion(turns));
			const cut = cutPointInstructions(turns, (answers as any).live_from);
			event.customInstructions = `${event.customInstructions ?? ""}\n${cut.instructions}`.trim();
			advisory = null;
		} catch (error) {
			warnOnce(ctx, "cutpoint", `cut-point pick failed (${error instanceof Error ? error.message : String(error)}); compaction proceeds without it.`);
		}
		return undefined;
	});

	// ---------------------------------------------------------------- tools

	// Tools register unconditionally (flag values only resolve after extension load); the
	// toggle and backend are checked inside execute instead.
	{
		const WHEN =
			"Use this for a judgment about what a file does or contains, without reading it into your context. " +
			"Write the question against `content`, which is the file's text. Use the read tool instead when you need the code itself, to edit or quote it. " +
			"Exact lookups, does this string appear, how many lines, belong to grep, not here.";
		const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], details: payload as Record<string, unknown> });
		const fail = (err: unknown) => ({
			content: [{ type: "text" as const, text: err instanceof FileStateError ? err.message : `error: ${err instanceof Error ? err.message : String(err)}` }],
			isError: true,
			details: undefined,
		});
		const unavailable = { content: [{ type: "text" as const, text: "jev is disabled or has no backend this session." }], isError: true, details: undefined };

		pi.registerTool({
			name: "ask_jev_file_bool",
			label: "Ask Jev about a file, yes or no",
			description: `Yes or no about one file. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. ${WHEN}`,
			promptSnippet: "Ask a yes/no question about a file without reading it into context",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the repo" }),
				question: Type.String({ description: "A yes or no question about `content`, for example: Does `content` validate authentication tokens?" }),
				yes: Type.Optional(Type.String({ description: "What counts as yes" })),
				no: Type.Optional(Type.String({ description: "What counts as no" })),
			}),
			async execute(_id, p, _signal, _u, ctx) {
				if (!enabled || !readsOn || !client?.available) return unavailable;
				try {
					return ok(await askFileBool(p.path, p.question, ctx.cwd, { yes: (p as any).yes, no: (p as any).no }, (s, q) => decide("ask_jev_file_bool", s, q, { path: p.path })));
				} catch (err) {
					return fail(err);
				}
			},
		});

		pi.registerTool({
			name: "ask_jev_file_choice",
			label: "Ask Jev about a file, pick one",
			description: `Pick one option about one file. Returns { path, choice, confidence, probabilities }. The choice is always one of your options; an "other" option is added if you leave none. ${WHEN}`,
			promptSnippet: "Classify a file into options you name without reading it into context",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the repo" }),
				question: Type.String({ description: "The question, for example: Which layer is `content`?" }),
				options: Type.Record(Type.String(), Type.String(), { description: "Option name to a one line description of when it applies. Up to 255." }),
			}),
			async execute(_id, p, _signal, _u, ctx) {
				if (!enabled || !readsOn || !client?.available) return unavailable;
				try {
					return ok(await askFileChoice(p.path, p.question, (p as any).options, ctx.cwd, (s, q) => decide("ask_jev_file_choice", s, q, { path: p.path })));
				} catch (err) {
					return fail(err);
				}
			},
		});

		pi.registerTool({
			name: "ask_jev_file_score",
			label: "Ask Jev about a file, on a scale",
			description: `A position on a scale you define, about one file. Returns { path, score, top, nearest, confidence, legend }. Levels are ordered low to high, two to ten of them, each a described situation. ${WHEN}`,
			promptSnippet: "Score a file on levels you describe without reading it into context",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the repo" }),
				question: Type.String({ description: "The question, for example: How risky is a refactor of `content`?" }),
				levels: Type.Array(Type.String(), { description: "Ordered low to high, each level a situation, for example: Isolated and well tested" }),
			}),
			async execute(_id, p, _signal, _u, ctx) {
				if (!enabled || !readsOn || !client?.available) return unavailable;
				try {
					return ok(await askFileScore(p.path, p.question, (p as any).levels, ctx.cwd, (s, q) => decide("ask_jev_file_score", s, q, { path: p.path })));
				} catch (err) {
					return fail(err);
				}
			},
		});
	}

	// ---------------------------------------------------------------- command + renderer

	pi.registerCommand("jev", {
		description: "jev status: backend, model, calls, estimated cost, blocks, screens, advisories, feature toggles",
		handler: async (_args, ctx) => {
			const lines = [
				`jev: ${enabled ? `on (${client?.backend}, model ${flag("jev-model") ?? "typesafe/jev-1.13"})` : "off"}`,
				`features: guard ${guardOn ? "on" : "off"}, reads ${readsOn ? "on" : "off"}, timing ${timingOn ? "on" : "off"}; self-compact ${hasSelfCompact ? "detected" : "absent"}`,
				`calls ${stats.calls}, est cost $${stats.costUsd.toFixed(6)}, blocked ${stats.blocked}, screened ${stats.screened}, advisories ${stats.advisories}`,
				`advisory now: ${advisory ?? "none"}`,
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const d = entry.data as { source?: string; answers?: Record<string, any>; ms?: number; costUsd?: number | null } | undefined;
		const answers = Object.entries(d?.answers ?? {})
			.map(([id, a]) => (a?.type === "noul" ? `${id} ${(a.noul as number).toFixed(2)}` : a?.type === "choice" ? `${id}=${a.choice}` : `${id}=${Number(a?.score).toFixed(2)}`))
			.join(", ");
		const cost = d?.costUsd != null ? ` $${d.costUsd.toFixed(6)}` : "";
		return new Text(theme.fg("dim", `[jev] ${d?.source ?? "?"} · ${answers} · ${d?.ms ?? "?"}ms${cost}`), 0, 0);
	});
}
