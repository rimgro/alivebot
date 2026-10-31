import * as fs from "node:fs";
import * as path from "node:path";
import { createSign } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../config.js";
import type { SandboxManager } from "../sandbox/manager.js";
import { withRetries, type RetryLogger } from "../retry.js";

const APP_FOR_PROFILE: Record<string, string> = {
	"slava-manager": "manager",
	developer: "developer",
	sre_devops: "sre",
};
const REPOSITORY = "rimgro/alivebot";
const API = "https://api.github.com";
const USER_AGENT = "alive-github-app-auth";
const tokenCache = new Map<string, { token: string; expiresAt: string; metadata: AppMetadata }>();

interface AppMetadata {
	app_id: number;
	slug: string;
	name: string;
	installation_id: number;
	installed_repository: string;
	permissions: Record<string, string>;
}

function encodeJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createAppJwt(appId: number, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iat: now - 30, exp: now + 540, iss: String(appId) })}`;
	const signer = createSign("RSA-SHA256");
	signer.update(unsigned);
	signer.end();
	return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

async function githubJson<T>(url: string, token: string, method = "GET", body?: unknown, signal?: AbortSignal, log?: RetryLogger): Promise<T> {
	const request = async (): Promise<T> => {
		const response = await fetch(url, {
			method,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"user-agent": USER_AGENT,
				"x-github-api-version": "2022-11-28",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal,
		});
		const data = await response.json().catch(() => ({})) as { message?: unknown };
		if (!response.ok) {
			const message = typeof data.message === "string" ? data.message.slice(0, 300) : "unknown GitHub API error";
			const error = new Error(`GitHub API request failed (${response.status}): ${message}`);
			// Status lets the shared classifier retry 5xx/429 and stop on 401/403.
			Object.assign(error, { status: response.status });
			throw error;
		}
		return data as T;
	};
	// Only reads are retried: a repeated POST/PATCH could duplicate a created
	// issue, comment or token. The token mint itself is not idempotent by contract.
	if (method !== "GET") return request();
	return withRetries(request, { attempts: 3, baseDelayMs: 500, maxDelayMs: 5_000, label: "github app", log, signal });
}

function readApp(stateDir: string, appProfile: string): { directory: string; metadata: AppMetadata; privateKey: string } {
	const appRoot = path.resolve(stateDir, "../../../github-apps");
	const directory = path.join(appRoot, appProfile);
	if (!directory.startsWith(`${appRoot}${path.sep}`)) throw new Error("Invalid GitHub App profile path");
	const directoryMode = fs.statSync(directory).mode & 0o777;
	if ((directoryMode & 0o077) !== 0) throw new Error("GitHub App credentials directory must be private (mode 0700)");
	const metadataPath = path.join(directory, "app.json");
	const keyPath = path.join(directory, "private-key.pem");
	for (const file of [metadataPath, keyPath]) {
		const mode = fs.statSync(file).mode & 0o777;
		if ((mode & 0o077) !== 0) throw new Error("GitHub App credential files must be private (mode 0600)");
	}
	const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as AppMetadata;
	if (!Number.isSafeInteger(metadata.app_id) || !Number.isSafeInteger(metadata.installation_id)
		|| typeof metadata.slug !== "string" || !/^[a-z0-9-]+$/.test(metadata.slug)
		|| metadata.installed_repository?.toLowerCase() !== REPOSITORY) {
		throw new Error("GitHub App is not fully installed on the expected repository");
	}
	return { directory, metadata, privateKey: fs.readFileSync(keyPath, "utf8") };
}

async function mintRepositoryToken(metadata: AppMetadata, privateKey: string, signal?: AbortSignal, log?: RetryLogger): Promise<{ token: string; expiresAt: string }> {
	const jwt = createAppJwt(metadata.app_id, privateKey);
	const app = await githubJson<{ id: number; slug: string }>(`${API}/app`, jwt, "GET", undefined, signal, log);
	if (app.id !== metadata.app_id || app.slug !== metadata.slug) throw new Error("GitHub App identity changed; refusing token mint");
	const installation = await githubJson<{ id: number; repository_selection: string; account?: { login?: string }; permissions?: Record<string, string> }>(
		`${API}/app/installations/${metadata.installation_id}`, jwt, "GET", undefined, signal, log,
	);
	if (installation.id !== metadata.installation_id || installation.repository_selection !== "selected"
		|| installation.account?.login?.toLowerCase() !== "rimgro") {
		throw new Error("GitHub App installation is no longer restricted to selected repositories for rimgro");
	}
	for (const [permission, level] of Object.entries(metadata.permissions)) {
		if (installation.permissions?.[permission] !== level) throw new Error(`GitHub App permission changed: ${permission}`);
	}
	const created = await githubJson<{ token: string; expires_at: string }>(
		`${API}/app/installations/${metadata.installation_id}/access_tokens`, jwt, "POST", { repository_names: ["alivebot"] }, signal, log,
	);
	if (typeof created.token !== "string" || typeof created.expires_at !== "string") throw new Error("GitHub did not return a valid installation token");
	const visible = await githubJson<{ repositories?: Array<{ full_name?: string }> }>(
		`${API}/installation/repositories`, created.token, "GET", undefined, signal, log,
	);
	const names = (visible.repositories ?? []).map((repo) => repo.full_name?.toLowerCase());
	if (names.length !== 1 || names[0] !== REPOSITORY) throw new Error("Installation token is not restricted to rimgro/alivebot");
	return { token: created.token, expiresAt: created.expires_at };
}

export function appProfileFor(loaded: LoadedConfig): string | undefined {
	const segments = loaded.paths.stateDir.split(path.sep).filter(Boolean);
	const agentsIndex = segments.lastIndexOf("agents");
	const profile = agentsIndex >= 0 ? segments[agentsIndex + 1] : undefined;
	return profile ? APP_FOR_PROFILE[profile] : undefined;
}

export async function getScopedInstallationToken(loaded: LoadedConfig, signal?: AbortSignal, log?: RetryLogger): Promise<{ token: string; expiresAt: string; metadata: AppMetadata }> {
	const profile = appProfileFor(loaded);
	if (!profile) throw new Error("This Alive profile has no GitHub App configured");
	const { metadata, privateKey } = readApp(loaded.paths.stateDir, profile);
	const cached = tokenCache.get(profile);
	if (cached && Date.parse(cached.expiresAt) > Date.now() + 120_000) return cached;
	const minted = await mintRepositoryToken(metadata, privateKey, signal, log);
	const result = { ...minted, metadata };
	tokenCache.set(profile, result);
	return result;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Add a narrow token-refresh tool only to the three profiles with dedicated GitHub Apps. */
export function createGitHubAuthTool(manager: SandboxManager, loaded: LoadedConfig, log?: RetryLogger): ToolDefinition | undefined {
	if (!appProfileFor(loaded)) return undefined;

	return {
		name: "github_auth",
		label: "Refresh GitHub App auth",
		description: "Mint a short-lived GitHub App installation token restricted to rimgro/alivebot, store it privately in your sandbox Git credential file, set your git commit author to your App bot identity, and clone/update the fixed repository at ./alivebot. The token is never returned in tool output. Call before GitHub work if the previous token expired. Manager has read-only code access; Developer and SRE can push only with explicit operator authorization.",
		promptSnippet: "Refresh scoped GitHub App auth and configure this agent's bot commit identity",
		parameters: Type.Object({ action: Type.Optional(Type.Literal("refresh")) }),
		async execute(_toolCallId, _params, signal) {
			return manager.exclusive(async () => {
				signal?.throwIfAborted();
				const { metadata, token, expiresAt } = await getScopedInstallationToken(loaded, signal, log);
				const credentialPath = path.posix.join(manager.workspaceDir, ".github-credentials-alive");
				const credential = `https://x-access-token:${token}@github.com/rimgro/alivebot.git\n`;
				const files = await manager.files();
				await files.write(manager.path(".github-credentials-alive"), credential);
				const username = `${metadata.slug}[bot]`;
				const email = `${metadata.app_id}+${metadata.slug}[bot]@users.noreply.github.com`;
				const command = [
					"if ! command -v git >/dev/null 2>&1; then apt-get update -qq && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*; fi",
					`chmod 600 ${shellQuote(credentialPath)}`,
					`git config --global user.name ${shellQuote(username)}`,
					`git config --global user.email ${shellQuote(email)}`,
					`git config --global credential.helper ${shellQuote(`store --file=${credentialPath}`)}`,
					"git config --global credential.useHttpPath true",
					"if [ -L alivebot ]; then echo 'refusing symlink at ./alivebot' >&2; exit 44; fi",
					`if [ -d alivebot/.git ]; then git -C alivebot remote set-url origin https://github.com/${REPOSITORY}.git; else git clone -- https://github.com/${REPOSITORY}.git alivebot; fi`,
					`git -C alivebot config --local user.name ${shellQuote(username)}`,
					`git -C alivebot config --local user.email ${shellQuote(email)}`,
					`git -C alivebot config --local credential.helper ${shellQuote(`store --file=${credentialPath}`)}`,
					"git -C alivebot config --local credential.useHttpPath true",
				].join(" && ");
				try {
					const result = await manager.execute(command, 300_000, signal);
					if (result.code !== 0) throw new Error(`Git auth setup failed (exit ${result.code}): ${result.text.slice(0, 2000)}`);
				} catch (error) {
					await files.write(manager.path(".github-credentials-alive"), "").catch(() => {});
					throw error;
				}
				return {
					content: [{ type: "text", text: `GitHub auth refreshed for ${username}. Repository is ./alivebot; token expires at ${expiresAt}. Token was not included in this response.` }],
					details: { app: metadata.slug, repository: REPOSITORY, tokenExpiresAt: expiresAt, tokenReturned: false },
				};
			});
		},
	};
}
