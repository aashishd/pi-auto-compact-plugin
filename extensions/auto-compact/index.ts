import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	findCutPoint,
	sessionEntryToContextMessages,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionEvent,
	type SessionEntry,
	type SessionStartEvent,
	type Theme,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SettingsList,
	Text,
	type Component,
	type Focusable,
	type SettingItem,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";

type ToolExecutionEndEvent = Extract<
	ExtensionEvent,
	{ type: "tool_execution_end" }
>;

export const AUTO_COMPACT_CONFIG_VERSION = 1;
export const AUTO_COMPACT_SESSION_ENTRY = "auto-compact-state";

export interface AutoCompactConfig {
	version: 1;
	enabledAtSessionStart: boolean;
	thresholdPercent: number;
	autoResume: boolean;
	resumptionInstruction: string;
	waitForTurnEnd: true;
	additionalCompactionInstruction: string;
}

interface AutoCompactSessionState {
	version: 1;
	isActive: boolean;
}

export const DEFAULT_AUTO_COMPACT_CONFIG: Readonly<AutoCompactConfig> = {
	version: AUTO_COMPACT_CONFIG_VERSION,
	enabledAtSessionStart: true,
	thresholdPercent: 60,
	autoResume: true,
	resumptionInstruction:
		"Continue the unfinished work from the compaction summary. Preserve prior decisions, avoid repeating completed work, and proceed with the next pending step.",
	waitForTurnEnd: true,
	additionalCompactionInstruction:
		"Preserve unfinished work and exact details required to resume safely.",
};

function defaultConfig(): AutoCompactConfig {
	return { ...DEFAULT_AUTO_COMPACT_CONFIG };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAutoCompactConfig(value: unknown): AutoCompactConfig {
	if (!isRecord(value)) return defaultConfig();
	if (
		Object.prototype.hasOwnProperty.call(value, "version") &&
		value.version !== AUTO_COMPACT_CONFIG_VERSION
	) {
		return defaultConfig();
	}
	return {
		version: AUTO_COMPACT_CONFIG_VERSION,
		enabledAtSessionStart:
			typeof value.enabledAtSessionStart === "boolean"
				? value.enabledAtSessionStart
				: DEFAULT_AUTO_COMPACT_CONFIG.enabledAtSessionStart,
		thresholdPercent:
			Number.isInteger(value.thresholdPercent) &&
			typeof value.thresholdPercent === "number" &&
			value.thresholdPercent >= 1 &&
			value.thresholdPercent <= 99
				? value.thresholdPercent
				: DEFAULT_AUTO_COMPACT_CONFIG.thresholdPercent,
		autoResume:
			typeof value.autoResume === "boolean"
				? value.autoResume
				: DEFAULT_AUTO_COMPACT_CONFIG.autoResume,
		resumptionInstruction:
			typeof value.resumptionInstruction === "string"
				? value.resumptionInstruction
				: DEFAULT_AUTO_COMPACT_CONFIG.resumptionInstruction,
		waitForTurnEnd: true,
		additionalCompactionInstruction:
			typeof value.additionalCompactionInstruction === "string"
				? value.additionalCompactionInstruction
				: DEFAULT_AUTO_COMPACT_CONFIG.additionalCompactionInstruction,
	};
}

export function getAutoCompactConfigPath(): string {
	const agentDirectory =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDirectory, "auto-compact.json");
}

export function readAutoCompactConfig(path = getAutoCompactConfigPath()): AutoCompactConfig {
	try {
		return normalizeAutoCompactConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return defaultConfig();
	}
}

export type RenameConfigFile = (temporaryPath: string, targetPath: string) => void;

export function writeAutoCompactConfig(
	path: string,
	config: AutoCompactConfig,
	renameFile: RenameConfigFile = renameSync,
): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const temporaryPath = join(
		directory,
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(
			descriptor,
			`${JSON.stringify(normalizeAutoCompactConfig(config), null, 2)}\n`,
			"utf8",
		);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameFile(temporaryPath, path);
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Preserve the original write error.
			}
		}
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The temporary file may not have been created or may already be renamed.
		}
		throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function validPercent(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasContextMessages(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
): boolean {
	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index];
		if (
			entry.type !== "compaction" &&
			sessionEntryToContextMessages(entry).length > 0
		) {
			return true;
		}
	}
	return false;
}

/**
 * Mirror Pi 0.81.1's non-mutating prepareCompaction eligibility decision using
 * its public cut-point and session-message APIs. This must stay synchronized
 * with the pinned Pi peer version.
 */
export function hasCompactableHistory(
	pathEntries: SessionEntry[],
	keepRecentTokens: number,
): boolean {
	if (pathEntries.at(-1)?.type === "compaction") return false;

	let previousCompactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		if (pathEntries[index].type === "compaction") {
			previousCompactionIndex = index;
			break;
		}
	}

	let boundaryStart = 0;
	if (previousCompactionIndex >= 0) {
		const previousCompaction = pathEntries[previousCompactionIndex];
		if (previousCompaction.type !== "compaction") return false;
		const firstKeptEntryIndex = pathEntries.findIndex(
			(entry) => entry.id === previousCompaction.firstKeptEntryId,
		);
		boundaryStart =
			firstKeptEntryIndex >= 0
				? firstKeptEntryIndex
				: previousCompactionIndex + 1;
	}

	const cutPoint = findCutPoint(
		pathEntries,
		boundaryStart,
		pathEntries.length,
		keepRecentTokens,
	);
	if (!pathEntries[cutPoint.firstKeptEntryIndex]?.id) return false;

	const historyEnd = cutPoint.isSplitTurn
		? cutPoint.turnStartIndex
		: cutPoint.firstKeptEntryIndex;
	if (hasContextMessages(pathEntries, boundaryStart, historyEnd)) return true;

	return (
		cutPoint.isSplitTurn &&
		hasContextMessages(
			pathEntries,
			cutPoint.turnStartIndex,
			cutPoint.firstKeptEntryIndex,
		)
	);
}

export type CanCompactSession = (ctx: ExtensionContext) => boolean;

export function canCompactCurrentSession(ctx: ExtensionContext): boolean {
	const settings = SettingsManager.create(ctx.cwd, undefined, {
		projectTrusted: ctx.isProjectTrusted(),
	}).getCompactionSettings();
	return hasCompactableHistory(
		ctx.sessionManager.getBranch(),
		settings.keepRecentTokens,
	);
}

function restoreSessionActivation(ctx: ExtensionContext): boolean | undefined {
	let restored: boolean | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== AUTO_COMPACT_SESSION_ENTRY) {
			continue;
		}
		const state = entry.data as Partial<AutoCompactSessionState> | undefined;
		if (typeof state?.isActive === "boolean") restored = state.isActive;
	}
	return restored;
}

function toolCallIds(event: TurnEndEvent): string[] {
	if (event.message.role !== "assistant") return [];
	const ids: string[] = [];
	for (const content of event.message.content) {
		if (content.type === "toolCall") ids.push(content.id);
	}
	return ids;
}

export function isInterruptedToolTurn(
	event: TurnEndEvent,
	terminatedToolCalls: ReadonlySet<string>,
): boolean {
	const ids = toolCallIds(event);
	return ids.length > 0 && !ids.some((id) => terminatedToolCalls.has(id));
}

export type PersistAutoCompactConfig = (
	path: string,
	config: AutoCompactConfig,
) => void;

export class AutoCompactRuntime {
	private config: AutoCompactConfig;
	private isActive: boolean;
	private detectorArmed = true;
	private inFlightToken: symbol | undefined;
	private generation = 0;
	private readonly terminatedToolCalls = new Set<string>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly configPath: string,
		initialConfig: AutoCompactConfig,
		private readonly persistConfig: PersistAutoCompactConfig = writeAutoCompactConfig,
		private readonly canCompactSession: CanCompactSession = canCompactCurrentSession,
	) {
		this.config = normalizeAutoCompactConfig(initialConfig);
		this.isActive = this.config.enabledAtSessionStart;
	}

	getConfig(): AutoCompactConfig {
		return { ...this.config };
	}

	getIsActive(): boolean {
		return this.isActive;
	}

	getDetectorState(): { armed: boolean; inFlight: boolean; generation: number } {
		return {
			armed: this.detectorArmed,
			inFlight: this.inFlightToken !== undefined,
			generation: this.generation,
		};
	}

	setSessionActive(active: boolean): void {
		this.isActive = active;
		this.pi.appendEntry<AutoCompactSessionState>(AUTO_COMPACT_SESSION_ENTRY, {
			version: AUTO_COMPACT_CONFIG_VERSION,
			isActive: active,
		});
	}

	updateGlobalConfig(config: AutoCompactConfig, ctx: ExtensionContext): boolean {
		const candidate = normalizeAutoCompactConfig(config);
		try {
			this.persistConfig(this.configPath, candidate);
		} catch (error) {
			notify(
				ctx,
				`Auto-compact config was not saved: ${errorMessage(error)}`,
				"error",
			);
			return false;
		}
		this.config = candidate;
		return true;
	}

	setWaitForTurnEnd(wait: boolean, ctx: ExtensionContext): boolean {
		if (!wait) {
			notify(
				ctx,
				"Wait for turn end must remain yes. Pi lacks a safe reliable live boundary, so eager compaction is deferred.",
				"warning",
			);
			return false;
		}
		return true;
	}

	resetDefaults(ctx: ExtensionContext): boolean {
		if (!this.updateGlobalConfig(defaultConfig(), ctx)) return false;
		this.setSessionActive(DEFAULT_AUTO_COMPACT_CONFIG.enabledAtSessionStart);
		return true;
	}

	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		this.generation++;
		this.inFlightToken = undefined;
		this.detectorArmed = true;
		this.terminatedToolCalls.clear();

		const mustUseStartupDefault = event.reason === "new" || event.reason === "fork";
		const restored = mustUseStartupDefault ? undefined : restoreSessionActivation(ctx);
		this.isActive = restored ?? this.config.enabledAtSessionStart;
		if (mustUseStartupDefault || restored === undefined) {
			this.pi.appendEntry<AutoCompactSessionState>(AUTO_COMPACT_SESSION_ENTRY, {
				version: AUTO_COMPACT_CONFIG_VERSION,
				isActive: this.isActive,
			});
		}
	}

	onSessionShutdown(): void {
		this.generation++;
		this.inFlightToken = undefined;
		this.terminatedToolCalls.clear();
	}

	onToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (isRecord(event.result) && event.result.terminate === true) {
			this.terminatedToolCalls.add(event.toolCallId);
		} else {
			this.terminatedToolCalls.delete(event.toolCallId);
		}
	}

	onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): void {
		const interrupted = isInterruptedToolTurn(event, this.terminatedToolCalls);
		this.terminatedToolCalls.clear();

		const percent = ctx.getContextUsage()?.percent;
		if (!validPercent(percent)) return;
		if (percent <= this.config.thresholdPercent) {
			this.detectorArmed = true;
			return;
		}
		if (!this.isActive || !this.detectorArmed || this.inFlightToken !== undefined) {
			return;
		}

		try {
			if (!this.canCompactSession(ctx)) return;
		} catch (error) {
			this.detectorArmed = false;
			notify(
				ctx,
				`Auto-compaction eligibility check failed: ${errorMessage(error)}`,
				"error",
			);
			return;
		}

		this.detectorArmed = false;
		const token = Symbol("auto-compact");
		const callbackGeneration = this.generation;
		this.inFlightToken = token;
		const additionalInstruction = this.config.additionalCompactionInstruction;
		const customInstructions = additionalInstruction.trim()
			? additionalInstruction
			: undefined;
		notify(
			ctx,
			`Auto-compacting at ${percent.toFixed(1)}% context usage.`,
			"info",
		);

		const resumeInterruptedWork = () => {
			if (!interrupted || !this.isActive || !this.config.autoResume) return;
			const instruction = this.config.resumptionInstruction;
			if (!instruction.trim()) return;
			try {
				this.pi.sendUserMessage(instruction, { deliverAs: "followUp" });
			} catch (resumeError) {
				notify(
					ctx,
					`Auto-compact could not resume: ${errorMessage(resumeError)}`,
					"error",
				);
			}
		};

		const settle = (error?: Error, resumeAfterFailure = true) => {
			if (
				callbackGeneration !== this.generation ||
				this.inFlightToken !== token
			) {
				return;
			}
			this.inFlightToken = undefined;
			if (error) {
				notify(ctx, `Auto-compaction failed: ${error.message}`, "error");
				if (resumeAfterFailure) resumeInterruptedWork();
				return;
			}

			notify(ctx, "Auto-compaction completed.", "info");
			resumeInterruptedWork();
		};

		try {
			ctx.compact({
				customInstructions,
				onComplete: () => settle(),
				onError: (error) => settle(error),
			});
		} catch (error) {
			settle(
				error instanceof Error ? error : new Error(String(error)),
				false,
			);
		}
	}
}

type AutoCompactSettingId =
	| "enabledAtSessionStart"
	| "isActive"
	| "thresholdPercent"
	| "autoResume"
	| "resumptionInstruction"
	| "waitForTurnEnd"
	| "additionalCompactionInstruction"
	| "resetDefaults"
	| "close";

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

function settingsListTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) =>
			selected ? theme.fg("accent", theme.bold(text)) : text,
		value: (text, selected) =>
			selected ? theme.fg("accent", text) : theme.fg("dim", text),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "›"),
		hint: (text) => theme.fg("dim", text),
	};
}

function valueInput(
	title: string,
	currentValue: string,
	theme: Theme,
	done: (selectedValue?: string) => void,
): Component & Focusable {
	const input = new Input();
	input.onSubmit = (value) => done(value);
	input.onEscape = () => done(undefined);
	return {
		get focused() {
			return input.focused;
		},
		set focused(value: boolean) {
			input.focused = value;
		},
		render: (width: number) => [
			theme.fg("accent", theme.bold(title)),
			theme.fg("dim", `Current: ${currentValue || "(empty)"}`),
			theme.fg("dim", "type replacement • enter save • esc back"),
			...input.render(width),
		],
		invalidate: () => input.invalidate(),
		handleInput: (data: string) => input.handleInput(data),
	};
}

function resetConfirmation(
	theme: Theme,
	done: (selectedValue?: string) => void,
): Component {
	const container = new Container();
	container.addChild(
		new Text(theme.fg("warning", theme.bold("Reset auto-compact defaults?")), 1, 1),
	);
	const list = new SettingsList(
		[
			{
				id: "confirm",
				label: "Confirm reset",
				currentValue: "no",
				values: ["no", "yes"],
				description:
					"Resets every machine-global value and activates auto-compact in this session.",
			},
			{
				id: "cancel",
				label: "Cancel",
				currentValue: "back",
				values: ["back"],
			},
		],
		4,
		settingsListTheme(theme),
		(id, value) => {
			if (id === "confirm" && value === "yes") done("confirmed");
			if (id === "cancel") done(undefined);
		},
		() => done(undefined),
	);
	container.addChild(list);
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
	};
}

function settingsItems(
	runtime: AutoCompactRuntime,
	theme: Theme,
): SettingItem[] {
	const config = runtime.getConfig();
	return [
		{
			id: "enabledAtSessionStart",
			label: "Enabled at session start",
			currentValue: yesNo(config.enabledAtSessionStart),
			values: ["yes", "no"],
			description:
				"Machine-global startup default. Changes affect future sessions only.",
		},
		{
			id: "isActive",
			label: "Active in current session",
			currentValue: yesNo(runtime.getIsActive()),
			values: ["yes", "no"],
			description:
				"New and forked sessions initialize from Enabled at session start; reload/resume of this session restores its stored state.",
		},
		{
			id: "thresholdPercent",
			label: "Threshold",
			currentValue: `${config.thresholdPercent}%`,
			description: "Integer context percentage from 1 through 99.",
			submenu: (_currentValue, done) =>
				valueInput(
					"Threshold percent (1..99)",
					String(runtime.getConfig().thresholdPercent),
					theme,
					done,
				),
		},
		{
			id: "autoResume",
			label: "Auto-resume",
			currentValue: yesNo(config.autoResume),
			values: ["yes", "no"],
			description:
				"Resume when an auto-compaction attempt interrupted a tool-driven turn, including after compaction failure.",
		},
		{
			id: "resumptionInstruction",
			label: "Resumption instruction",
			currentValue: config.resumptionInstruction || "(empty)",
			description:
				"User message queued once after an interrupted compaction attempt finishes.",
			submenu: (_currentValue, done) =>
				valueInput(
					"Resumption instruction",
					runtime.getConfig().resumptionInstruction,
					theme,
					done,
				),
		},
		{
			id: "waitForTurnEnd",
			label: "Wait for turn end",
			currentValue: "yes",
			values: ["yes", "no"],
			description:
				"Required together with the native-history eligibility preflight. Live compaction is not supported.",
		},
		{
			id: "additionalCompactionInstruction",
			label: "Additional compaction instruction",
			currentValue: config.additionalCompactionInstruction || "(native prompt only)",
			description:
				"Pi's native /compact instruction is always used. This text is appended only as additional guidance and never edits or replaces the native instruction. " +
				"Changing it may affect compaction quality. Empty means native prompt only.",
			submenu: (_currentValue, done) =>
				valueInput(
					"Additional compaction instruction",
					runtime.getConfig().additionalCompactionInstruction,
					theme,
					done,
				),
		},
		{
			id: "resetDefaults",
			label: "Reset defaults",
			currentValue: "open",
			description: "Requires confirmation before resetting global and session values.",
			submenu: (_currentValue, done) => resetConfirmation(theme, done),
		},
		{
			id: "close",
			label: "Close",
			currentValue: "close",
			values: ["close"],
		},
	];
}

async function openAutoCompactSettings(
	ctx: ExtensionCommandContext,
	runtime: AutoCompactRuntime,
): Promise<void> {
	await ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Auto-compact Settings")), 1, 1),
			);
			let settingsList: SettingsList;
			const refresh = () => {
				for (const item of settingsItems(runtime, theme)) {
					settingsList.updateValue(item.id, item.currentValue);
				}
				tui.requestRender();
			};
			const saveGlobal = (
				patch: Partial<Omit<AutoCompactConfig, "version" | "waitForTurnEnd">>,
				message: string,
			) => {
				const saved = runtime.updateGlobalConfig(
					{ ...runtime.getConfig(), ...patch },
					ctx,
				);
				if (saved) notify(ctx, message, "info");
				refresh();
			};

			settingsList = new SettingsList(
				settingsItems(runtime, theme),
				10,
				settingsListTheme(theme),
				(id, newValue) => {
					const action = id as AutoCompactSettingId;
					switch (action) {
						case "enabledAtSessionStart":
							saveGlobal(
								{ enabledAtSessionStart: newValue === "yes" },
								"Auto-compact startup default updated for future sessions.",
							);
							return;
						case "isActive":
							runtime.setSessionActive(newValue === "yes");
							notify(
								ctx,
								`Auto-compact ${newValue === "yes" ? "enabled" : "disabled"} for this session.`,
								"info",
							);
							refresh();
							return;
						case "thresholdPercent": {
							const threshold = Number(newValue);
							if (
								!Number.isInteger(threshold) ||
								threshold < 1 ||
								threshold > 99
							) {
								notify(
									ctx,
									"Threshold must be an integer from 1 through 99.",
									"warning",
								);
								refresh();
								return;
							}
							saveGlobal(
								{ thresholdPercent: threshold },
								`Auto-compact threshold set to ${threshold}%.`,
							);
							return;
						}
						case "autoResume":
							saveGlobal(
								{ autoResume: newValue === "yes" },
								`Auto-resume ${newValue === "yes" ? "enabled" : "disabled"}.`,
							);
							return;
						case "resumptionInstruction":
							saveGlobal(
								{ resumptionInstruction: newValue },
								"Auto-compact resumption instruction updated.",
							);
							return;
						case "waitForTurnEnd":
							runtime.setWaitForTurnEnd(newValue === "yes", ctx);
							refresh();
							return;
						case "additionalCompactionInstruction":
							saveGlobal(
								{ additionalCompactionInstruction: newValue },
								"Additional compaction guidance updated.",
							);
							return;
						case "resetDefaults":
							if (newValue === "confirmed" && runtime.resetDefaults(ctx)) {
								notify(
									ctx,
									"Auto-compact defaults restored and enabled for this session.",
									"info",
								);
							}
							refresh();
							return;
						case "close":
							done(undefined);
					}
				},
				() => done(undefined),
			);
			container.addChild(settingsList);
			container.addChild(
				new Text(
					theme.fg("dim", "j/k scroll • enter edit/save • esc close"),
					1,
					0,
				),
			);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-left",
				width: 92,
				maxHeight: "85%",
				margin: { bottom: 1 },
			},
		},
	);
}

export interface AutoCompactExtensionOptions {
	configPath?: string;
	initialConfig?: AutoCompactConfig;
	persistConfig?: PersistAutoCompactConfig;
	canCompactSession?: CanCompactSession;
	onRuntime?: (runtime: AutoCompactRuntime) => void;
}

export function registerAutoCompactExtension(
	pi: ExtensionAPI,
	options: AutoCompactExtensionOptions = {},
): AutoCompactRuntime {
	const configPath = options.configPath ?? getAutoCompactConfigPath();
	const runtime = new AutoCompactRuntime(
		pi,
		configPath,
		options.initialConfig ?? readAutoCompactConfig(configPath),
		options.persistConfig,
		options.canCompactSession,
	);
	options.onRuntime?.(runtime);

	pi.registerCommand("auto-compact", {
		description: "Toggle auto-compaction for the current session",
		handler: async (_args, ctx) => {
			const active = !runtime.getIsActive();
			runtime.setSessionActive(active);
			notify(
				ctx,
				`Auto-compact ${active ? "enabled" : "disabled"} for this session.`,
				"info",
			);
		},
	});

	pi.registerCommand("auto-compact-config", {
		description: "Configure auto-compaction",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				notify(ctx, "/auto-compact-config requires TUI mode.", "warning");
				return;
			}
			try {
				await openAutoCompactSettings(ctx, runtime);
			} catch (error) {
				notify(
					ctx,
					`Could not open auto-compact settings: ${errorMessage(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_start", (event, ctx) => runtime.onSessionStart(event, ctx));
	pi.on("session_shutdown", () => runtime.onSessionShutdown());
	pi.on("tool_execution_end", (event) => runtime.onToolExecutionEnd(event));
	pi.on("turn_end", (event, ctx) => runtime.onTurnEnd(event, ctx));

	return runtime;
}

export default function autoCompactExtension(pi: ExtensionAPI): void {
	registerAutoCompactExtension(pi);
}
