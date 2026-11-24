/**
 * GitHub App profile/repository resolution test:
 *
 *   npx tsx src/dev/github-auth-test.ts
 *
 * Filesystem fixtures for config loading and credential-gate checks only: no
 * network, no real credentials and no sandbox. The network-facing token mint is
 * covered by its pure checks (repository parsing/matching) rather than a live
 * GitHub App.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig, type LoadedConfig } from "../config.js";
import {
	APP_FOR_PROFILE,
	appProfileFor,
	createGitHubAuthTool,
	githubAppRoot,
	githubToolsEnabled,
	hasGitHubAppCredentials,
	profileFromStateDir,
	repositoryFor,
} from "../github/app-auth.js";
import { createGitHubApiTool } from "../github/api-tool.js";
import type { SandboxManager } from "../sandbox/manager.js";
import {
	DEFAULT_GITHUB_CONFIG,
	DEFAULT_GITHUB_REPOSITORY,
	parseGitHubRepository,
	repositoryDirectory,
	repositoryMatches,
	validateGitHubConfig,
	type GitHubConfig,
} from "../github/config.js";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		process.stdout.write(`  ok    ${name}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`);
}

function section(name: string): void {
	process.stdout.write(`\n${name}\n`);
}

function managedStateDir(profile: string): string {
	return path.join(os.tmpdir(), "alive-github-test", "agents", profile, "state");
}

function loadedAt(stateDir: string, github?: Partial<GitHubConfig>): LoadedConfig {
	return {
		config: {
			...DEFAULT_CONFIG,
			github: { ...DEFAULT_GITHUB_CONFIG, ...github },
		},
		paths: { stateDir },
	} as unknown as LoadedConfig;
}

function loadedWithoutGitHubBlock(stateDir: string): LoadedConfig {
	const config = { ...DEFAULT_CONFIG } as Record<string, unknown>;
	delete config.github;
	return { config, paths: { stateDir } } as unknown as LoadedConfig;
}

function errorOf(fn: () => unknown): string {
	try {
		fn();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function writeCredentials(appRoot: string, app: string): string {
	const directory = path.join(appRoot, app);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	const metadata = path.join(directory, "app.json");
	const key = path.join(directory, "private-key.pem");
	fs.writeFileSync(metadata, JSON.stringify({ app_id: 1, installation_id: 1, slug: app, installed_repository: DEFAULT_GITHUB_REPOSITORY }), { mode: 0o600 });
	fs.writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n", { mode: 0o600 });
	fs.chmodSync(metadata, 0o600);
	fs.chmodSync(key, 0o600);
	return directory;
}

// ---------------------------------------------------------------------------
section("legacy profile mapping is unchanged");
{
	check("slava-manager -> manager", appProfileFor(loadedAt(managedStateDir("slava-manager"))) === "manager");
	check("developer -> developer", appProfileFor(loadedAt(managedStateDir("developer"))) === "developer");
	check("sre_devops -> sre", appProfileFor(loadedAt(managedStateDir("sre_devops"))) === "sre");
	check(
		"the built-in map still contains exactly the three historical profiles",
		Object.keys(APP_FOR_PROFILE).sort().join(",") === "developer,slava-manager,sre_devops",
		APP_FOR_PROFILE,
	);
}

// ---------------------------------------------------------------------------
section("new managed profiles use their own id; explicit github.app wins");
{
	check("festival -> festival", appProfileFor(loadedAt(managedStateDir("festival"))) === "festival");
	check("nfc -> nfc", appProfileFor(loadedAt(managedStateDir("nfc"))) === "nfc");
	check("an unrelated managed profile -> its id", appProfileFor(loadedAt(managedStateDir("writer"))) === "writer");
	check("profile id is read from <state>/agents/<id>/state", profileFromStateDir(managedStateDir("festival")) === "festival", managedStateDir("festival"));
	check("a root profile still has no App by default", appProfileFor(loadedAt(path.join(os.tmpdir(), "alive-github-test"))) === undefined);
	check("github.app works even at the root", appProfileFor(loadedAt(path.join(os.tmpdir(), "alive-github-test"), { app: "festival" })) === "festival");
	check(
		"github.app overrides the historical mapping",
		appProfileFor(loadedAt(managedStateDir("slava-manager"), { app: "extra-app" })) === "extra-app",
	);
	check(
		"an empty github.app keeps the profile fallback",
		appProfileFor(loadedAt(managedStateDir("festival"), { app: "   " })) === "festival",
	);
	check(
		"managed credentials stay in .alive/github-apps",
		githubAppRoot(managedStateDir("festival")) === path.resolve(managedStateDir("festival"), "../../../github-apps"),
		githubAppRoot(managedStateDir("festival")),
	);
	check(
		"root-profile credentials live next to its state",
		githubAppRoot(path.join(os.tmpdir(), "alive-github-test", ".alive")) === path.join(os.tmpdir(), "alive-github-test", ".alive", "github-apps"),
		githubAppRoot(path.join(os.tmpdir(), "alive-github-test", ".alive")),
	);
}

// ---------------------------------------------------------------------------
section("repository resolution defaults to the historical repository");
{
	const stateDir = managedStateDir("festival");
	check("a missing github block uses the default", repositoryFor(loadedWithoutGitHubBlock(stateDir)) === DEFAULT_GITHUB_REPOSITORY);
	check("an empty repository uses the default", repositoryFor(loadedAt(stateDir, { repository: "" })) === DEFAULT_GITHUB_REPOSITORY);
	check("whitespace repository uses the default", repositoryFor(loadedAt(stateDir, { repository: "  " })) === DEFAULT_GITHUB_REPOSITORY);
	check("the default is rimgro/alivebot", DEFAULT_GITHUB_REPOSITORY === "rimgro/alivebot", DEFAULT_GITHUB_REPOSITORY);
	check("a configured repository is used", repositoryFor(loadedAt(stateDir, { repository: "acme/widget" })) === "acme/widget");
	check("surrounding whitespace is trimmed", repositoryFor(loadedAt(stateDir, { repository: "  acme/widget  " })) === "acme/widget");
	check("case is preserved for display/API paths", repositoryFor(loadedAt(stateDir, { repository: "Acme/Widget" })) === "Acme/Widget");
	check("an invalid configured repository throws", errorOf(() => repositoryFor(loadedAt(stateDir, { repository: "not-a-repository" }))) === 'github.repository must be in "owner/repo" form');
}

// ---------------------------------------------------------------------------
section("repository parsing, matching and clone directory");
{
	const parsed = parseGitHubRepository(" Rimgro/AliveBot ");
	check("owner and name are split exactly once", parsed.owner === "Rimgro" && parsed.name === "AliveBot" && parsed.fullName === "Rimgro/AliveBot", parsed);
	check("matching is case-insensitive", repositoryMatches("rimgro/ALIVEBOT", DEFAULT_GITHUB_REPOSITORY));
	check("a different repository is a mismatch", !repositoryMatches("rimgro/other", DEFAULT_GITHUB_REPOSITORY));
	check("a missing repository is a mismatch", !repositoryMatches(undefined, DEFAULT_GITHUB_REPOSITORY));
	check("the default clone directory stays ./alivebot", repositoryDirectory(DEFAULT_GITHUB_REPOSITORY) === "alivebot");
	check("a configured clone directory uses the repository name", repositoryDirectory("acme/widget") === "widget");
	check("owner/repo/extra is rejected", errorOf(() => parseGitHubRepository("acme/widget/extra")).startsWith("github.repository"));
	check("a bare name is rejected", errorOf(() => parseGitHubRepository("widget")).startsWith("github.repository"));
	check(".. as a repository name is rejected", errorOf(() => parseGitHubRepository("acme/..")).startsWith("github.repository"));
}

// ---------------------------------------------------------------------------
section("github config validation");
{
	const defaults = validateGitHubConfig(undefined);
	check("absent config keeps empty app + default repository", defaults.app === "" && defaults.repository === DEFAULT_GITHUB_REPOSITORY, defaults);
	const explicit = validateGitHubConfig({ app: " festival ", repository: " acme/widget " });
	check("valid values are trimmed and kept", explicit.app === "festival" && explicit.repository === "acme/widget", explicit);
	const empty = validateGitHubConfig({ app: "", repository: "" });
	check("empty strings fall back to the defaults", empty.app === "" && empty.repository === DEFAULT_GITHUB_REPOSITORY, empty);
	const rejects: Array<[string, unknown]> = [
		["a non-object block", "festival"],
		["an array block", []],
		["a numeric app", { app: 42 }],
		["an app path with a slash", { app: "../manager" }],
		["an app path with a backslash", { app: "manager\\evil" }],
		["a leading-dot app", { app: ".." }],
		["a numeric repository", { repository: 42 }],
		["a repository without an owner", { repository: "alivebot" }],
		["a repository with extra segments", { repository: "rimgro/alivebot/extra" }],
		["a dot-dot repository name", { repository: "rimgro/.." }],
	];
	for (const [label, value] of rejects) {
		const message = errorOf(() => validateGitHubConfig(value));
		check(`${label} is rejected`, message.startsWith("github"), message || "accepted");
	}
}

// ---------------------------------------------------------------------------
section("GitHub tools are gated on credentials unless github.app is explicit");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-github-gate-"));
	const appRoot = path.join(root, ".alive", "github-apps");
	const manager = {} as unknown as SandboxManager;
	const tools = (loaded: LoadedConfig) => ({
		auth: createGitHubAuthTool(manager, loaded),
		api: createGitHubApiTool(loaded),
	});
	try {
		const editorState = path.join(root, ".alive", "agents", "editor", "state");
		const noCredentials = loadedAt(editorState);
		check("a managed profile without credentials is not available", !hasGitHubAppCredentials(editorState, "editor"));
		check("a managed profile without credentials gets no github tools", !githubToolsEnabled(noCredentials) && tools(noCredentials).auth === undefined && tools(noCredentials).api === undefined);

		const explicitWithoutDirectory = loadedAt(editorState, { app: "festival" });
		check("an explicit github.app enables tools without a directory", githubToolsEnabled(explicitWithoutDirectory) && tools(explicitWithoutDirectory).auth !== undefined && tools(explicitWithoutDirectory).api !== undefined);
		check("the explicit app itself still has no credentials", !hasGitHubAppCredentials(editorState, "festival"));

		writeCredentials(appRoot, "festival");
		const explicitWithDirectory = loadedAt(editorState, { app: "festival" });
		check("an explicit github.app with credentials stays enabled", githubToolsEnabled(explicitWithDirectory) && tools(explicitWithDirectory).auth !== undefined && tools(explicitWithDirectory).api !== undefined);
		check("the explicit App directory is now complete", hasGitHubAppCredentials(editorState, "festival"));

		writeCredentials(appRoot, "editor");
		const withCredentials = loadedAt(editorState);
		check("a managed profile with credentials gets both tools", githubToolsEnabled(withCredentials) && tools(withCredentials).auth !== undefined && tools(withCredentials).api !== undefined);
		check("the managed profile App directory is complete", hasGitHubAppCredentials(editorState, "editor"));

		writeCredentials(appRoot, "manager");
		const legacy = loadedAt(path.join(root, ".alive", "agents", "slava-manager", "state"));
		check("the historical slava-manager mapping still works with its directory", githubToolsEnabled(legacy) && tools(legacy).auth !== undefined && tools(legacy).api !== undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
section("loadConfig wires github.app and github.repository into the profile");
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "alive-github-config-"));
	const write = (value: unknown): void => {
		fs.writeFileSync(path.join(root, "alive.config.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
	};
	const load = (): LoadedConfig => loadConfig({
		cwd: root,
		migrateSecrets: false,
		secretLog: () => undefined,
		secretWarn: () => undefined,
	});
	try {
		write({ stateDir: ".alive/agents/festival/state", github: { app: "custom-app", repository: "acme/widget" } });
		const configured = load();
		check("github.app is read from the profile config", appProfileFor(configured) === "custom-app", configured.config.github);
		check("github.repository is read from the profile config", repositoryFor(configured) === "acme/widget", configured.config.github);

		write({ stateDir: ".alive/agents/nfc/state" });
		const fallback = load();
		check("a profile without github.app falls back to its id", appProfileFor(fallback) === "nfc", fallback.config.github);
		check("a profile without github.repository keeps the default", repositoryFor(fallback) === DEFAULT_GITHUB_REPOSITORY, fallback.config.github);

		write({ stateDir: ".alive/agents/festival/state", github: { repository: "not-a-repository" } });
		const message = errorOf(load);
		check("loadConfig rejects an invalid repository", message.startsWith("github.repository"), message || "accepted");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

process.stdout.write(`\n${failures === 0 ? "all GitHub auth tests passed" : `${failures} GitHub auth test(s) failed`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
