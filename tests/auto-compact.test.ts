import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import {
	AUTO_COMPACT_SESSION_ENTRY,
	DEFAULT_AUTO_COMPACT_CONFIG,
	hasCompactableHistory,
	normalizeAutoCompactConfig,
	readAutoCompactConfig,
	registerAutoCompactExtension,
	writeAutoCompactConfig,
} from "../extensions/auto-compact/index.ts";

function createPiHarness({
	config = {},
	persistConfig = () => undefined,
	compactImplementation = () => undefined,
	canCompactSession = () => true,
} = {}) {
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const sentUserMessages = [];
	const notifications = [];
	const compactCalls = [];
	let percent = null;

	const pi = {
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		on(name, handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
		sendUserMessage(content, options) {
			sentUserMessages.push({ content, options });
		},
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp/auto-compact-test",
		isProjectTrusted: () => true,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
		sessionManager: {
			getEntries: () => entries,
		},
		getContextUsage: () =>
			percent === undefined ? undefined : { percent, tokens: null, contextWindow: 100_000 },
		compact(options) {
			compactCalls.push(options);
			compactImplementation(options);
		},
	};
	const initialConfig = normalizeAutoCompactConfig({
		...DEFAULT_AUTO_COMPACT_CONFIG,
		...config,
	});
	const runtime = registerAutoCompactExtension(pi, {
		configPath: "/tmp/auto-compact-test.json",
		initialConfig,
		persistConfig,
		canCompactSession,
	});
	const emit = async (name, event, context = ctx) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, context);
		}
	};
	return {
		commands,
		compactCalls,
		ctx,
		emit,
		entries,
		notifications,
		runtime,
		sentUserMessages,
		setPercent(value) {
			percent = value;
		},
	};
}

function finalTurn() {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Finished." }],
			stopReason: "stop",
		},
		toolResults: [],
	};
}

function toolTurn(id = "tool-1") {
	return toolBatchTurn([id]);
}

function toolBatchTurn(ids) {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: ids.map((id) => ({
				type: "toolCall",
				id,
				name: "read",
				arguments: {},
			})),
			stopReason: "toolUse",
		},
		toolResults: ids.map((id) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		})),
	};
}

async function start(harness, reason = "startup") {
	await harness.emit("session_start", { type: "session_start", reason });
}

test("normalizes supported and missing versions but defaults unsupported versions", () => {
	assert.deepEqual(normalizeAutoCompactConfig(undefined), DEFAULT_AUTO_COMPACT_CONFIG);
	assert.deepEqual(
		normalizeAutoCompactConfig({
			version: 99,
			enabledAtSessionStart: false,
			thresholdPercent: 99,
			autoResume: false,
			resumptionInstruction: "",
			waitForTurnEnd: false,
			additionalCompactionInstruction: "supplement",
		}),
		DEFAULT_AUTO_COMPACT_CONFIG,
	);
	assert.deepEqual(
		normalizeAutoCompactConfig({
			version: 1,
			enabledAtSessionStart: false,
			thresholdPercent: 99,
			autoResume: false,
			resumptionInstruction: "",
			waitForTurnEnd: false,
			additionalCompactionInstruction: "supplement",
		}),
		{
			version: 1,
			enabledAtSessionStart: false,
			thresholdPercent: 99,
			autoResume: false,
			resumptionInstruction: "",
			waitForTurnEnd: true,
			additionalCompactionInstruction: "supplement",
		},
	);
	assert.deepEqual(
		normalizeAutoCompactConfig({ thresholdPercent: 42, autoResume: false }),
		{
			...DEFAULT_AUTO_COMPACT_CONFIG,
			thresholdPercent: 42,
			autoResume: false,
		},
	);
	const invalid = normalizeAutoCompactConfig({
		enabledAtSessionStart: "yes",
		thresholdPercent: 100,
		autoResume: 1,
		resumptionInstruction: null,
		additionalCompactionInstruction: {},
	});
	assert.deepEqual(invalid, DEFAULT_AUTO_COMPACT_CONFIG);
});

test("malformed, missing, and partial config files use field-level defaults without eager writes", () => {
	const directory = mkdtempSync(join(tmpdir(), "auto-compact-load-"));
	const missing = join(directory, "missing.json");
	assert.deepEqual(readAutoCompactConfig(missing), DEFAULT_AUTO_COMPACT_CONFIG);
	assert.equal(readdirSync(directory).includes("missing.json"), false);

	const malformed = join(directory, "malformed.json");
	writeFileSync(malformed, "{not-json\n");
	assert.deepEqual(readAutoCompactConfig(malformed), DEFAULT_AUTO_COMPACT_CONFIG);

	const partial = join(directory, "partial.json");
	writeFileSync(partial, JSON.stringify({ thresholdPercent: 42, autoResume: false }));
	assert.deepEqual(readAutoCompactConfig(partial), {
		...DEFAULT_AUTO_COMPACT_CONFIG,
		thresholdPercent: 42,
		autoResume: false,
	});
});

test("atomic rename failure preserves the prior valid config and removes the temp file", () => {
	const directory = mkdtempSync(join(tmpdir(), "auto-compact-write-"));
	const path = join(directory, "auto-compact.json");
	const previous = { ...DEFAULT_AUTO_COMPACT_CONFIG, thresholdPercent: 55 };
	writeAutoCompactConfig(path, previous);
	const before = readFileSync(path, "utf8");

	assert.throws(
		() =>
			writeAutoCompactConfig(
				path,
				{ ...previous, thresholdPercent: 75 },
				() => {
					throw new Error("rename failed");
				},
			),
		/rename failed/,
	);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.deepEqual(readdirSync(directory), ["auto-compact.json"]);
});

test("registers exactly two commands and session toggles never write global config", async () => {
	let globalWrites = 0;
	const harness = createPiHarness({
		persistConfig: () => {
			globalWrites++;
		},
	});
	assert.deepEqual([...harness.commands.keys()].sort(), [
		"auto-compact",
		"auto-compact-config",
	]);
	await start(harness);
	assert.equal(harness.runtime.getIsActive(), true);

	await harness.commands.get("auto-compact").handler("", harness.ctx);
	assert.equal(harness.runtime.getIsActive(), false);
	assert.equal(globalWrites, 0);
	assert.equal(harness.entries.at(-1).customType, AUTO_COMPACT_SESSION_ENTRY);
	assert.equal(harness.entries.at(-1).data.isActive, false);

	await start(harness, "reload");
	assert.equal(harness.runtime.getIsActive(), false);
});

test("settings command builds an editor-adjacent SettingsList overlay with Pi's installed TUI", async () => {
	const harness = createPiHarness();
	await start(harness);
	let rendered = [];
	harness.ctx.ui.custom = async (factory, options) => {
		assert.deepEqual(options, {
			overlay: true,
			overlayOptions: {
				anchor: "bottom-left",
				width: 92,
				maxHeight: "85%",
				margin: { bottom: 1 },
			},
		});
		const component = factory(
			{ requestRender() {} },
			{
				bold: (text) => text,
				fg: (_color, text) => text,
			},
			{},
			() => undefined,
		);
		rendered = component.render(100);
	};
	await harness.commands.get("auto-compact-config").handler("", harness.ctx);
	assert.match(rendered.join("\n"), /Auto-compact Settings/);
	assert.match(rendered.join("\n"), /Enabled at session start/);
});

test("new and forked sessions use the machine startup default instead of copied toggles", async () => {
	const harness = createPiHarness();
	harness.entries.push({
		type: "custom",
		customType: AUTO_COMPACT_SESSION_ENTRY,
		data: { version: 1, isActive: false },
	});
	await start(harness, "resume");
	assert.equal(harness.runtime.getIsActive(), false);

	await start(harness, "fork");
	assert.equal(harness.runtime.getIsActive(), true);
	assert.equal(harness.entries.at(-1).data.isActive, true);

	harness.runtime.setSessionActive(false);
	await start(harness, "new");
	assert.equal(harness.runtime.getIsActive(), true);
	assert.equal(harness.entries.at(-1).data.isActive, true);
});

function sessionMessage(id, parentId, role, text, usage) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: [{ type: "text", text }],
			...(role === "assistant"
				? {
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						usage:
							usage ?? {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
						stopReason: "stop",
					}
				: {}),
			timestamp: Date.now(),
		},
	};
}

function highUsage() {
	return {
		input: 178_000,
		output: 432,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 178_432,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantToolMessage(id, parentId, toolCallId) {
	const entry = sessionMessage(id, parentId, "assistant", "");
	entry.message.content = [
		{ type: "toolCall", id: toolCallId, name: "read", arguments: {} },
	];
	entry.message.stopReason = "toolUse";
	return entry;
}

function toolResultMessage(id, parentId, toolCallId, text) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		},
	};
}

test("compactability preflight exactly matches Pi preparation for small and eligible histories", () => {
	const tooSmall = [
		sessionMessage("u1", null, "user", "small request"),
		sessionMessage("a1", "u1", "assistant", "small response", highUsage()),
	];
	const eligible = [
		sessionMessage("u1", null, "user", "older request"),
		sessionMessage("a1", "u1", "assistant", "older response"),
		sessionMessage("u2", "a1", "user", "x".repeat(80)),
		sessionMessage("a2", "u2", "assistant", "recent response"),
	];

	for (const { entries, keepRecentTokens } of [
		{ entries: tooSmall, keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens },
		{ entries: eligible, keepRecentTokens: 10 },
	]) {
		assert.equal(
			hasCompactableHistory(entries, keepRecentTokens),
			prepareCompaction(entries, {
				...DEFAULT_COMPACTION_SETTINGS,
				keepRecentTokens,
			}) !== undefined,
		);
	}
	assert.equal(Number(((highUsage().totalTokens / 272_000) * 100).toFixed(1)), 65.6);
	assert.equal(hasCompactableHistory(tooSmall, 20_000), false);
	assert.equal(hasCompactableHistory(eligible, 10), true);

	const completedCompaction = {
		type: "compaction",
		id: "c1",
		parentId: "a2",
		timestamp: new Date().toISOString(),
		summary: "summary",
		firstKeptEntryId: "u2",
		tokensBefore: 100,
	};
	const endingInCompaction = [...eligible, completedCompaction];
	assert.equal(hasCompactableHistory(endingInCompaction, 10), false);
	assert.equal(
		prepareCompaction(endingInCompaction, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 10,
		}),
		undefined,
	);

	const splitTurn = [
		sessionMessage("split-u1", null, "user", "one tool turn"),
		assistantToolMessage("split-a1", "split-u1", "call-1"),
		toolResultMessage("split-t1", "split-a1", "call-1", "x".repeat(100)),
		sessionMessage("split-a2", "split-t1", "assistant", "recent response"),
	];
	const splitPreparation = prepareCompaction(splitTurn, {
		...DEFAULT_COMPACTION_SETTINGS,
		keepRecentTokens: 10,
	});
	assert.equal(splitPreparation?.isSplitTurn, true);
	assert.equal(hasCompactableHistory(splitTurn, 10), true);

	const afterPreviousCompaction = [
		...eligible,
		completedCompaction,
		sessionMessage("u3", "c1", "user", "post-compaction request"),
		sessionMessage("a3", "u3", "assistant", "post-compaction response"),
		sessionMessage("u4", "a3", "user", "y".repeat(100)),
		sessionMessage("a4", "u4", "assistant", "newest response"),
	];
	assert.equal(hasCompactableHistory(afterPreviousCompaction, 10), true);
	assert.equal(
		hasCompactableHistory(afterPreviousCompaction, 10),
		prepareCompaction(afterPreviousCompaction, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 10,
		}) !== undefined,
	);
});

test("high usage without compactable history is a non-destructive no-op", async () => {
	let compactable = false;
	const harness = createPiHarness({
		canCompactSession: () => compactable,
	});
	await start(harness);
	harness.setPercent(65.6);
	await harness.emit("turn_end", toolTurn());
	assert.equal(harness.compactCalls.length, 0);
	assert.equal(harness.sentUserMessages.length, 0);
	assert.equal(harness.notifications.length, 0);
	assert.deepEqual(harness.runtime.getDetectorState(), {
		armed: true,
		inFlight: false,
		generation: 1,
	});

	compactable = true;
	await harness.emit("turn_end", toolTurn("tool-2"));
	assert.equal(harness.compactCalls.length, 1);
});

test("eligibility check failure disarms detection without invoking compaction", async () => {
	const harness = createPiHarness({
		canCompactSession: () => {
			throw new Error("settings unavailable");
		},
	});
	await start(harness);
	harness.setPercent(61);
	await harness.emit("turn_end", toolTurn());
	assert.equal(harness.compactCalls.length, 0);
	assert.equal(harness.runtime.getDetectorState().armed, false);
	assert.match(harness.notifications.at(-1).message, /eligibility check failed/);
});

test("inactive runtime never compacts above the configured threshold", async () => {
	const harness = createPiHarness();
	await start(harness);
	harness.runtime.setSessionActive(false);
	harness.setPercent(99);
	await harness.emit("turn_end", toolTurn());
	assert.equal(harness.compactCalls.length, 0);
	assert.equal(harness.runtime.getDetectorState().inFlight, false);
});

test("uses a strict percentage threshold, handles null, triggers once above, and rearms at or below", async () => {
	const harness = createPiHarness({ config: { autoResume: false } });
	await start(harness);

	harness.setPercent(null);
	await harness.emit("turn_end", finalTurn());
	harness.setPercent(undefined);
	await harness.emit("turn_end", finalTurn());
	harness.setPercent(Number.NaN);
	await harness.emit("turn_end", finalTurn());
	harness.setPercent(60);
	await harness.emit("turn_end", finalTurn());
	assert.equal(harness.compactCalls.length, 0);

	harness.setPercent(60.01);
	await harness.emit("turn_end", finalTurn());
	assert.equal(harness.compactCalls.length, 1);
	harness.setPercent(90);
	await harness.emit("turn_end", finalTurn());
	assert.equal(harness.compactCalls.length, 1);
	harness.compactCalls[0].onComplete({});
	harness.setPercent(90);
	await harness.emit("turn_end", finalTurn());
	assert.equal(harness.compactCalls.length, 1);

	harness.setPercent(60);
	await harness.emit("turn_end", finalTurn());
	harness.setPercent(61);
	await harness.emit("turn_end", finalTurn());
	assert.equal(harness.compactCalls.length, 2);
});

test("write failure preserves effective runtime config and reset updates globals plus session activation", async () => {
	const directory = mkdtempSync(join(tmpdir(), "auto-compact-runtime-"));
	const path = join(directory, "auto-compact.json");
	const prior = normalizeAutoCompactConfig({
		...DEFAULT_AUTO_COMPACT_CONFIG,
		enabledAtSessionStart: false,
		thresholdPercent: 25,
		autoResume: false,
	});
	writeAutoCompactConfig(path, prior);
	let rejectWrites = true;
	const persisted = [];
	const harness = createPiHarness({
		config: prior,
		persistConfig: (_target, candidate) => {
			if (rejectWrites) throw new Error("disk full");
			persisted.push(candidate);
			writeAutoCompactConfig(path, candidate);
		},
	});
	await start(harness);
	assert.equal(harness.runtime.getIsActive(), false);

	assert.equal(
		harness.runtime.updateGlobalConfig(
			{ ...harness.runtime.getConfig(), thresholdPercent: 80 },
			harness.ctx,
		),
		false,
	);
	assert.deepEqual(harness.runtime.getConfig(), prior);
	assert.deepEqual(readAutoCompactConfig(path), prior);

	rejectWrites = false;
	assert.equal(harness.runtime.resetDefaults(harness.ctx), true);
	assert.deepEqual(harness.runtime.getConfig(), DEFAULT_AUTO_COMPACT_CONFIG);
	assert.equal(harness.runtime.getIsActive(), true);
	assert.deepEqual(persisted, [DEFAULT_AUTO_COMPACT_CONFIG]);
	assert.deepEqual(readAutoCompactConfig(path), DEFAULT_AUTO_COMPACT_CONFIG);
	assert.equal(harness.entries.at(-1).data.isActive, true);
});

test("successful auto-compaction resumes an interrupted tool turn exactly once", async () => {
	const harness = createPiHarness();
	await start(harness);
	harness.setPercent(61);
	await harness.emit("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId: "tool-1",
		toolName: "read",
		result: { content: [], terminate: false },
		isError: false,
	});
	await harness.emit("turn_end", toolTurn());
	assert.equal(harness.compactCalls.length, 1);

	harness.compactCalls[0].onComplete({});
	harness.compactCalls[0].onComplete({});
	assert.deepEqual(harness.sentUserMessages, [
		{
			content: DEFAULT_AUTO_COMPACT_CONFIG.resumptionInstruction,
			options: { deliverAs: "followUp" },
		},
	]);
});

test("synchronous compact rejection disarms, clears state, and does not resume", async () => {
	const harness = createPiHarness({
		compactImplementation: () => {
			throw new Error("synchronous failure");
		},
	});
	await start(harness);
	harness.setPercent(61);
	await harness.emit("turn_end", toolTurn());
	assert.equal(harness.compactCalls.length, 1);
	assert.deepEqual(harness.runtime.getDetectorState(), {
		armed: false,
		inFlight: false,
		generation: 1,
	});
	assert.equal(harness.sentUserMessages.length, 0);
	assert.match(harness.notifications.at(-1).message, /synchronous failure/);
});

test("session reload invalidates stale completion and error callbacks", async (t) => {
	await t.test("stale onComplete", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn());
		await start(harness, "reload");
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.runtime.getDetectorState().inFlight, false);
		assert.equal(harness.sentUserMessages.length, 0);
		assert.equal(
			harness.notifications.some(({ message }) => /completed/.test(message)),
			false,
		);
	});

	await t.test("stale onError", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn());
		await start(harness, "reload");
		harness.compactCalls[0].onError(new Error("stale failure"));
		assert.equal(harness.runtime.getDetectorState().inFlight, false);
		assert.equal(harness.sentUserMessages.length, 0);
		assert.equal(
			harness.notifications.some(({ message }) => /stale failure/.test(message)),
			false,
		);
	});
});

test("resumes only eligible interrupted compaction attempts", async (t) => {
	await t.test("final assistant response", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", finalTurn());
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.sentUserMessages.length, 0);
	});

	await t.test("failed final assistant response", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", finalTurn());
		harness.compactCalls[0].onError(new Error("failed"));
		assert.equal(harness.sentUserMessages.length, 0);
	});

	await t.test("tool batch that requested termination", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: { content: [], terminate: true },
			isError: false,
		});
		await harness.emit("turn_end", toolTurn());
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.sentUserMessages.length, 0);
	});

	await t.test("mixed tool batch containing a termination request", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "questionnaire",
			result: { content: [], terminate: true },
			isError: false,
		});
		await harness.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId: "tool-2",
			toolName: "read",
			result: { content: [], terminate: false },
			isError: false,
		});
		await harness.emit("turn_end", toolBatchTurn(["tool-1", "tool-2"]));
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.sentUserMessages.length, 0);
	});

	await t.test("compaction error resumes once and does not enter a retry loop", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn());
		harness.compactCalls[0].onError(new Error("failed"));
		harness.compactCalls[0].onError(new Error("duplicate failure"));
		assert.deepEqual(harness.sentUserMessages, [
			{
				content: DEFAULT_AUTO_COMPACT_CONFIG.resumptionInstruction,
				options: { deliverAs: "followUp" },
			},
		]);
		assert.equal(harness.runtime.getDetectorState().inFlight, false);
		assert.equal(harness.runtime.getDetectorState().armed, false);

		await harness.emit("turn_end", toolTurn("tool-2"));
		assert.equal(harness.compactCalls.length, 1);

		harness.setPercent(60);
		await harness.emit("turn_end", finalTurn());
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn("tool-3"));
		assert.equal(harness.compactCalls.length, 2);
	});

	await t.test("stale callback after session replacement", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn());
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.sentUserMessages.length, 0);
	});

	await t.test("disabled while compaction is in flight", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn());
		harness.runtime.setSessionActive(false);
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.sentUserMessages.length, 0);
	});

	await t.test("auto-resume disabled while compaction is in flight", async () => {
		const harness = createPiHarness();
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn());
		harness.runtime.updateGlobalConfig(
			{ ...harness.runtime.getConfig(), autoResume: false },
			harness.ctx,
		);
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.sentUserMessages.length, 0);
	});

	await t.test("empty resumption instruction", async () => {
		const harness = createPiHarness({ config: { resumptionInstruction: "   " } });
		await start(harness);
		harness.setPercent(61);
		await harness.emit("turn_end", toolTurn());
		harness.compactCalls[0].onComplete({});
		assert.equal(harness.sentUserMessages.length, 0);
	});
});

test("rejects waitForTurnEnd false without persisting or changing effective config", async () => {
	let writes = 0;
	const harness = createPiHarness({
		persistConfig: () => {
			writes++;
		},
	});
	await start(harness);
	assert.equal(harness.runtime.setWaitForTurnEnd(false, harness.ctx), false);
	assert.equal(harness.runtime.getConfig().waitForTurnEnd, true);
	assert.equal(writes, 0);
	assert.match(harness.notifications.at(-1).message, /safe reliable live boundary/);
});

test("passes only supplemental guidance as customInstructions and uses undefined when blank", async () => {
	const supplemental = "Only this supplemental text.";
	const harness = createPiHarness({
		config: { autoResume: false, additionalCompactionInstruction: supplemental },
	});
	await start(harness);
	harness.setPercent(61);
	await harness.emit("turn_end", finalTurn());
	assert.deepEqual(
		Object.keys(harness.compactCalls[0]).sort(),
		["customInstructions", "onComplete", "onError"],
	);
	assert.equal(harness.compactCalls[0].customInstructions, supplemental);
	assert.doesNotMatch(
		harness.compactCalls[0].customInstructions,
		/compact.*conversation|summary.*format/i,
	);

	const blank = createPiHarness({
		config: { autoResume: false, additionalCompactionInstruction: "   " },
	});
	await start(blank);
	blank.setPercent(61);
	await blank.emit("turn_end", finalTurn());
	assert.equal(blank.compactCalls[0].customInstructions, undefined);
});
