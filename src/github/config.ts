/**
 * Pure GitHub App settings shared by config validation and the GitHub tools.
 *
 * Keeping parsing/validation here (rather than in the network-facing module)
 * means profile resolution and repository matching can be unit-tested without
 * credentials, a sandbox or GitHub itself.
 */

/** Repository the original three profiles used when no `github.repository` is set. */
export const DEFAULT_GITHUB_REPOSITORY = "rimgro/alivebot";

export interface GitHubConfig {
	/**
	 * GitHub App credential directory under `.alive/github-apps/`. Empty means:
	 * use the built-in legacy profile mapping, otherwise the managed profile id.
	 */
	app: string;
	/** Repository in `owner/name` form. Empty means `DEFAULT_GITHUB_REPOSITORY`. */
	repository: string;
}

export const DEFAULT_GITHUB_CONFIG: GitHubConfig = {
	app: "",
	repository: DEFAULT_GITHUB_REPOSITORY,
};

// A directory name only: no separators, no `.`/`..`, and no absolute paths.
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// GitHub owner/repository grammar is deliberately limited to one slash. A name
// of `.` or `..` is rejected by parseGitHubRepository below because it would
// also be a dangerous clone directory.
const REPOSITORY_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

export interface ParsedGitHubRepository {
	/** Account/org login exactly as configured. */
	owner: string;
	/** Repository name (`owner/name` without the owner). */
	name: string;
	/** Canonical `owner/name` string, trimmed. */
	fullName: string;
}

/** Parse and validate one `owner/name` repository string. */
export function parseGitHubRepository(value: string): ParsedGitHubRepository {
	const fullName = value.trim();
	const match = REPOSITORY_RE.exec(fullName);
	if (!match) throw new Error('github.repository must be in "owner/repo" form');
	const owner = match[1];
	const name = match[2];
	if (name === "." || name === "..") throw new Error('github.repository must be in "owner/repo" form');
	return { owner, name, fullName };
}

/** Case-insensitive repository comparison; GitHub treats `Owner/Repo` and `owner/repo` as the same. */
export function repositoryMatches(actual: string | undefined, expected: string): boolean {
	return typeof actual === "string" && actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

/** Directory used inside the sandbox for the configured repository (`owner/name` -> `name`). */
export function repositoryDirectory(repository: string): string {
	return parseGitHubRepository(repository).name;
}

/** Validate the optional `github` config block; absent/empty settings keep historical defaults. */
export function validateGitHubConfig(value: unknown): GitHubConfig {
	if (value === undefined || value === null) return { ...DEFAULT_GITHUB_CONFIG };
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("github must be an object");
	const raw = value as Partial<Record<keyof GitHubConfig, unknown>>;
	const rawApp = raw.app === undefined || raw.app === null ? "" : raw.app;
	if (typeof rawApp !== "string") throw new Error("github.app must be a string (GitHub App directory name)");
	const app = rawApp.trim();
	if (app && !APP_NAME_RE.test(app)) {
		throw new Error("github.app must be a plain directory name (letters, digits, dot, dash, underscore)");
	}
	const rawRepository = raw.repository === undefined || raw.repository === null ? "" : raw.repository;
	if (typeof rawRepository !== "string") throw new Error("github.repository must be a string in \"owner/repo\" form");
	const repository = rawRepository.trim() ? parseGitHubRepository(rawRepository).fullName : DEFAULT_GITHUB_REPOSITORY;
	return { app, repository };
}
