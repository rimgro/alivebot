import { createHash } from "node:crypto";
import * as path from "node:path";
import type { LoadedConfig } from "../config.js";

/** Stable opaque scope: it identifies this runtime's state without exposing its path. */
export function privateMemoryScope(config: LoadedConfig): string {
	const stateDir = path.resolve(config.paths.stateDir);
	return `agent:${createHash("sha256").update(stateDir).digest("hex").slice(0, 20)}`;
}

export function sharedMemoryScopes(config: LoadedConfig): string[] {
	return [...new Set(config.config.memory.sharedScopes.map((scope) => scope.trim()).filter(Boolean))];
}

/** Search defaults to private facts. Shared scopes are opt-in per query and config allowlist. */
export function searchableMemoryScopes(config: LoadedConfig, requested: string[] = []): string[] {
	const allowed = new Set(sharedMemoryScopes(config));
	const denied = [...new Set(requested.map((scope) => scope.trim()).filter(Boolean))].filter((scope) => !allowed.has(scope));
	if (denied.length) throw new Error(`memory scopes are not allowlisted for this agent: ${denied.join(", ")}`);
	return [...new Set([privateMemoryScope(config), ...requested.map((scope) => scope.trim()).filter(Boolean)])].sort();
}

/** Every retained fact is private to this agent unless it names an allowlisted shared scope. */
export function retainedMemoryScopes(config: LoadedConfig, requested: string[]): string[] {
	return searchableMemoryScopes(config, requested);
}

export function canReadMemoryFact(config: LoadedConfig, factScopes: string[], requestedSharedScopes: string[] = []): boolean {
	const visible = new Set(searchableMemoryScopes(config, requestedSharedScopes));
	return factScopes.some((scope) => visible.has(scope));
}
