import * as path from "node:path";
import { newId, readJson, writeJsonAtomic } from "../util.js";
import type { AliveEvent, EventKind, EventPriority } from "./events.js";

/**
 * What to do with an inbound event that arrives while the agent is working.
 *
 * - `interrupt` — steer it into the running agent immediately.
 * - `queue`     — hold it in the inbox; the agent sees it on its next `idle`.
 * - `mute`      — never show it (it is skipped and acknowledged unseen).
 */
export type NotifyMode = "interrupt" | "queue" | "mute";

export interface NotifyRule {
	id: string;
	mode: NotifyMode;
	thread?: string;
	source?: string;
	kind?: EventKind;
	priority?: EventPriority;
	note?: string;
	createdAt: number;
}

export interface NotifyPolicyFile {
	version: number;
	/** Mode used when no rule matches. */
	defaultMode: NotifyMode;
	rules: NotifyRule[];
}

export const DEFAULT_POLICY: NotifyPolicyFile = {
	version: 1,
	defaultMode: "queue",
	rules: [
		{
			id: "seed_interrupt_priority",
			mode: "interrupt",
			priority: "interrupt",
			note: "events explicitly marked interrupt always reach the agent",
			createdAt: 0,
		},
	],
};

function matches(rule: NotifyRule, event: AliveEvent): boolean {
	if (rule.thread !== undefined && rule.thread !== event.thread) return false;
	if (rule.source !== undefined && rule.source !== event.source) return false;
	if (rule.kind !== undefined && rule.kind !== event.kind) return false;
	if (rule.priority !== undefined && rule.priority !== event.priority) return false;
	return true;
}

function specificity(rule: NotifyRule): number {
	let count = 0;
	if (rule.thread !== undefined) count += 1;
	if (rule.source !== undefined) count += 1;
	if (rule.kind !== undefined) count += 1;
	if (rule.priority !== undefined) count += 1;
	return count;
}

/**
 * The agent-editable notification policy: when is the world allowed to break
 * into work that is already in progress?
 *
 * This is deliberately a separate store (not a note) because the runtime has to
 * evaluate it on the hot path, and because the agent is expected to tune it
 * ("Alice is important, interrupt me for anything from her").
 */
export class PolicyStore {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = path.join(stateDir, "policy.json");
		if (!readJson<NotifyPolicyFile | null>(this.file, null)) writeJsonAtomic(this.file, DEFAULT_POLICY);
	}

	load(): NotifyPolicyFile {
		const policy = readJson<NotifyPolicyFile>(this.file, DEFAULT_POLICY);
		return {
			version: policy.version ?? 1,
			defaultMode: policy.defaultMode ?? "queue",
			rules: Array.isArray(policy.rules) ? policy.rules : [],
		};
	}

	private save(policy: NotifyPolicyFile): void {
		writeJsonAtomic(this.file, policy);
	}

	/**
	 * Effective mode for an event. Rules are ranked by how many fields they pin
	 * down (more specific wins), then by recency (a just-added rule beats an older
	 * rule of the same specificity). First match wins.
	 */
	modeFor(event: AliveEvent): NotifyMode {
		const policy = this.load();
		const ranked = [...policy.rules].sort((a, b) => {
			const bySpecificity = specificity(b) - specificity(a);
			if (bySpecificity !== 0) return bySpecificity;
			return b.createdAt - a.createdAt;
		});
		for (const rule of ranked) {
			if (matches(rule, event)) return rule.mode;
		}
		return policy.defaultMode;
	}

	shouldInterrupt(event: AliveEvent): boolean {
		return this.modeFor(event) === "interrupt";
	}

	shouldMute(event: AliveEvent): boolean {
		return this.modeFor(event) === "mute";
	}

	add(input: Omit<NotifyRule, "id" | "createdAt"> & { note?: string }): NotifyRule {
		const policy = this.load();
		const rule: NotifyRule = { ...input, id: newId("rule"), createdAt: Date.now() };
		policy.rules.push(rule);
		this.save(policy);
		return rule;
	}

	remove(id: string): NotifyRule | null {
		const policy = this.load();
		const index = policy.rules.findIndex((rule) => rule.id === id || rule.id.startsWith(id));
		if (index < 0) return null;
		const [removed] = policy.rules.splice(index, 1);
		this.save(policy);
		return removed ?? null;
	}

	setDefault(mode: NotifyMode): void {
		const policy = this.load();
		policy.defaultMode = mode;
		this.save(policy);
	}

	reset(): NotifyPolicyFile {
		this.save(structuredClone(DEFAULT_POLICY));
		return this.load();
	}
}
