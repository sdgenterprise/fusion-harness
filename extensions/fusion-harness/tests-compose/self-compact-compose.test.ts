/**
 * Composition smoke test: fusion-harness + jev + self-compact loaded into ONE pi process.
 *
 * fusion-harness loads FIRST (it clears pi's default footer at session_start), jev SECOND
 * (mock backend: guards and the cut-point pick run offline with safe canned answers),
 * self-compact LAST (its context-gauge footer installs after, so it wins the row).
 * All three extensions' commands must register, and the full self-compact lifecycle must
 * complete with the harness active: notice -> warning -> forced lock -> self_compact ->
 * compaction -> verbatim note -> the continuation writes result.txt = done. Zero API cost:
 * the model is self-compact's scripted fake provider.
 *
 * Run with: just compose-test   (node --test, not bun: it drives pi --mode rpc)
 * Skips when the sibling self-compact-pi-agent checkout is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF_COMPACT_APP = resolve(REPO_ROOT, "..", "self-compact-pi-agent", "apps", "self-compact");
const FUSION_EXT = resolve(REPO_ROOT, "extensions", "fusion-harness", "fusion-harness.ts");
const JEV_EXT = resolve(REPO_ROOT, "extensions", "jev", "jev.ts");
const PERCENT_FLAGS = ["--compact-soft-at", "20%", "--compact-at", "50%", "--compact-buffer", "10%"];
const HANDOFF = "self-compact-handoff";

test("fusion-harness + self-compact: full lifecycle in one process", { skip: !existsSync(SELF_COMPACT_APP) }, async () => {
	const { RpcClient, eventsOfType } = await import(resolve(SELF_COMPACT_APP, "tests", "harness", "rpc-client.ts"));
	const { DEFAULT_FAKE_ENV, makeTestDir, scriptedArgs } = await import(resolve(SELF_COMPACT_APP, "tests", "harness", "env.ts"));

	const t = makeTestDir("compose-fusion");
	// scriptedArgs loads self-compact + the fake provider; insert fusion-harness and jev (mock) FIRST.
	const base = scriptedArgs(t, PERCENT_FLAGS);
	const eIdx = base.indexOf("-e");
	const args = [...base.slice(0, eIdx), "-e", FUSION_EXT, "-e", JEV_EXT, "--jev-backend", "mock", ...base.slice(eIdx)];
	const client = new RpcClient({
		args,
		cwd: t.dir,
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_SCENARIO: "ignore-until-forced", SC_FAKE_TRACE: t.traceFile },
		logFile: t.logFile,
	});
	try {
		// All three extensions' commands are registered in the same session.
		const cmds = await client.request({ type: "get_commands" });
		const names = JSON.stringify(cmds);
		assert.ok(names.includes("fh-reset"), `fusion-harness commands missing: ${names}`);
		assert.ok(names.includes("self-compact-info"), `self-compact commands missing: ${names}`);
		assert.ok(names.includes("jev"), `jev command missing: ${names}`);

		// Drive the scripted lifecycle with the harness active.
		const accepted = await client.request({ type: "prompt", message: "Start the scripted work." });
		assert.equal(accepted.success, true, JSON.stringify(accepted));
		const handoff = await client.waitFor(
			(e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === HANDOFF,
			90_000,
		);
		const after = client.events.indexOf(handoff);
		await client.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "write", 30_000, { since: after });
		await client.waitFor((e) => e.type === "agent_settled", 60_000, { since: after });

		// Thresholds crossed in order; the note came back; the follow-up work ran.
		const phases = eventsOfType(client.events, "entry_appended")
			.filter((e) => (e.entry as { customType?: string })?.customType === "self-compact-phase")
			.map((e) => ((e.entry as { data?: { level?: string } }).data ?? {}).level);
		assert.deepEqual(phases.slice(0, 3), ["notice", "warning", "forced"]);
		assert.equal(readFileSync(`${t.dir}/result.txt`, "utf-8"), "done");

		// No extension reported an error, and jev's mock cut-point pick reached the compaction.
		assert.deepEqual(eventsOfType(client.events, "extension_error"), []);
		const jevDecisions = eventsOfType(client.events, "entry_appended").filter(
			(e) => (e.entry as { customType?: string })?.customType === "jev-decision",
		);
		assert.ok(jevDecisions.length >= 1, "expected at least one jev decision entry (cut point at compaction)");
	} finally {
		await client.close();
	}
});
