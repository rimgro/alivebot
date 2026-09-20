import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AliveConfig, LoadedConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { AliveModule, AliveModuleFactory } from "./api.js";

export interface ModuleLoadResult {
	modules: AliveModule[];
	errors: Array<{ name: string; error: string }>;
}

/**
 * Instantiate every configured module: built-ins by name, user modules by path.
 *
 * Loading is best-effort per module: a broken user module must not prevent the
 * agent from starting. Failures are returned so the runtime can surface them in
 * `alive status` and the logs.
 */
export async function loadModules(config: LoadedConfig, log: Logger): Promise<ModuleLoadResult> {
	const modules: AliveModule[] = [];
	const errors: ModuleLoadResult["errors"] = [];
	const cfg = config.config;

	if (cfg.modules.telegram.enabled) {
		try {
			const { TelegramModule } = await import("../modules/telegram/module.js");
			modules.push(new TelegramModule(cfg.modules.telegram));
		} catch (err) {
			errors.push({ name: "telegram", error: message(err) });
		}
	}

	if (cfg.modules.grafana.enabled) {
		try {
			const { GrafanaModule } = await import("../modules/grafana/module.js");
			modules.push(new GrafanaModule(cfg.modules.grafana));
		} catch (err) {
			errors.push({ name: "grafana", error: message(err) });
		}
	}

	for (const spec of cfg.modules.external) {
		if (spec.enabled === false) continue;
		try {
			modules.push(await loadExternalModule(config, log, spec.name, spec.path, spec.options));
		} catch (err) {
			errors.push({ name: spec.name, error: message(err) });
		}
	}

	for (const error of errors) log.error(`module ${error.name} failed to load`, { error: error.error });
	return { modules, errors };
}

async function loadExternalModule(
	config: LoadedConfig,
	log: Logger,
	name: string,
	specPath: string,
	options: Record<string, unknown>,
): Promise<AliveModule> {
	const resolved = path.isAbsolute(specPath) ? specPath : path.resolve(config.paths.rootDir, specPath);
	const imported = (await import(pathToFileURL(resolved).href)) as {
		default?: unknown;
		createModule?: unknown;
		create?: unknown;
	};
	const factory = pickFactory(imported);
	if (!factory) {
		throw new Error(`module file ${specPath} must export a default factory or a named createModule()`);
	}
	const instance = await factory({ config: config.config, log: log.child(`module:${name}`), options: options ?? {} });
	if (!instance || typeof instance !== "object") {
		throw new Error(`module factory for ${name} did not return a module`);
	}
	const module = instance as AliveModule;
	if (typeof module.start !== "function" || typeof module.stop !== "function") {
		throw new Error(`module ${name} must implement start(ctx) and stop()`);
	}
	return module.name ? module : { ...module, name };
}

function pickFactory(imported: { default?: unknown; createModule?: unknown; create?: unknown }): AliveModuleFactory | undefined {
	for (const candidate of [imported.default, imported.createModule, imported.create]) {
		if (typeof candidate === "function") return candidate as AliveModuleFactory;
	}
	return undefined;
}

/** A config-only description for `alive modules` (no module code is imported). */
export interface ModuleDescription {
	name: string;
	enabled: boolean;
	source: "builtin" | "external";
	detail?: string;
}

export function describeModules(config: AliveConfig): ModuleDescription[] {
	const out: ModuleDescription[] = [];
	const telegram = config.modules.telegram;
	out.push({
		name: "telegram",
		enabled: telegram.enabled,
		source: "builtin",
		detail: telegram.enabled
			? `${telegram.tokenEnv || "—"}${telegram.allowedChatIds.length > 0 ? `, ${telegram.allowedChatIds.length} chat(s)` : ", all chats"}`
			: undefined,
	});
	const grafana = config.modules.grafana;
	out.push({
		name: "grafana",
		enabled: grafana.enabled,
		source: "builtin",
		detail: grafana.enabled ? `http://${grafana.host}:${grafana.port}${grafana.path}` : undefined,
	});
	for (const spec of config.modules.external) {
		out.push({
			name: spec.name,
			enabled: spec.enabled !== false,
			source: "external",
			detail: spec.path,
		});
	}
	return out;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
