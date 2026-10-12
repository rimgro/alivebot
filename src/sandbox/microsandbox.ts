import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { Sandbox, NetworkPolicy } from "microsandbox";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { defaultModelSpec, type LoadedConfig } from "../config.js";
import { privateMemoryScope, sharedMemoryScopes } from "../runtime/memory-access.js";

/** Run one managed Alive runtime in an attached, per-agent Microsandbox VM. */
export async function superviseInMicrosandbox(config: LoadedConfig): Promise<void> {
	const cfg = config.config;
	if (cfg.modules.telegram.enabled) throw new Error("Microsandbox agents cannot load Telegram host secrets yet; disable the Telegram module");
	if (cfg.modules.grafana.enabled) throw new Error("Microsandbox agents cannot expose the Grafana host listener yet");
	if (cfg.modules.external.length || cfg.extensions.length) throw new Error("Microsandbox agents cannot load host-path modules/extensions yet");
	if (cfg.chat.http.enabled) throw new Error("Microsandbox agents cannot expose the HTTP chat listener yet");
	if (cfg.memory.sharedScopes.length) throw new Error("shared memory scopes are not supported in Microsandbox mode yet");

	fs.mkdirSync(config.paths.stateDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(config.paths.workspaceDir, { recursive: true, mode: 0o700 });
	await migratePrivateMemory(config);
	persistPrivateMemoryPath(config);
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), "alive-microsandbox-"));
	const guestConfig = structuredClone(cfg);
	guestConfig.stateDir = "/alive/state";
	guestConfig.workspace = "/alive/workspace";
	guestConfig.soulFile = "/alive/config/SOUL.md";
	guestConfig.piAgentDir = "/alive/config/pi-agent";
	guestConfig.memory.databasePath = "/alive/state/memory.sqlite";
	guestConfig.modules.external = [];
	guestConfig.extensions = [];
	fs.writeFileSync(path.join(stage, "alive.config.json"), `${JSON.stringify(guestConfig, null, 2)}\n`, { mode: 0o600 });
	for (const [source, target] of [[config.paths.soulPath, "SOUL.md"], [config.paths.contractPath, "CONTRACT.md"], [config.paths.summaryPath, "summary.md"]] as const) {
		if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, target), fs.constants.COPYFILE_FICLONE);
	}
	fs.mkdirSync(path.join(stage, "pi-agent"), { recursive: true, mode: 0o700 });

	const modelCredential = await stageModelCredential(config, stage);
	guestConfig.model = modelCredential.modelSpec;
	fs.writeFileSync(path.join(stage, "alive.config.json"), `${JSON.stringify(guestConfig, null, 2)}\n`, { mode: 0o600 });
	const apiSecrets: ApiSecret[] = [modelCredential];
	const embeddingSecret = stageEmbeddingCredential(config);
	if (embeddingSecret) apiSecrets.push(embeddingSecret);
	const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const name = `alive-${createHash("sha256").update(config.paths.stateDir).digest("hex").slice(0, 32)}`;
	const policy = NetworkPolicy.builder()
		.defaultDeny()
		.egress((rule) => rule.tcp().udp().port(53).allow((destination) => destination.group("host")))
		.egress((rule) => rule.allowPublic().allowLoopback());
	const builder = Sandbox.builder(name)
		.replace()
		.image(cfg.sandbox.image)
		.cpus(cfg.sandbox.cpus)
		.memory(cfg.sandbox.memoryMiB)
		.rootDisk(8192)
		.workdir("/opt/alive")
		.network((network) => {
			network.policyFromBuilder(policy);
			for (const secret of apiSecrets) network.secretEnv(secret.envVar, secret.value, secret.placeholder, secret.host);
			return network;
		})
		.patch((patch) => patch.copyDir(path.join(appRoot, "dist"), "/opt/alive/dist").copyFile(path.join(appRoot, "package.json"), "/opt/alive/package.json").copyFile(path.join(appRoot, "package-lock.json"), "/opt/alive/package-lock.json"))
		.volume("/alive/config", (mount) => mount.bind(stage).readonly().noexec().nosuid().nodev().statVirtualization("strict"))
		.volume("/alive/state", (mount) => mount.bind(config.paths.stateDir).noexec().nosuid().nodev().statVirtualization("strict").quota(4096))
		.volume("/alive/workspace", (mount) => mount.bind(config.paths.workspaceDir).noexec().nosuid().nodev().statVirtualization("strict").quota(4096))
		.env("ALIVE_DAEMON", "1")
		.env("ALIVE_IN_MICROSANDBOX", "1")
		.env("ALIVE_RUNTIME_PID", String(process.pid));
	if (embeddingSecret) builder.env(embeddingSecret.envVar, embeddingSecret.placeholder);
	let sandbox: Sandbox | undefined;
	let stopping = false;
	const stop = () => {
		stopping = true;
		if (sandbox) void sandbox.stop().catch(() => undefined);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		sandbox = await builder.create();
		const install = await sandbox.exec("npm", ["ci", "--omit=dev", "--ignore-scripts"]);
		if (!install.success) throw new Error(`guest dependency install failed: ${install.stderr()}`);
		const run = await sandbox.execStream("node", ["/opt/alive/dist/index.js", "run", "--foreground", "--config", "/alive/config/alive.config.json"]);
		void (async () => {
			for await (const event of run) {
				if (event.kind === "stdout") process.stdout.write(Buffer.from(event.data));
				else if (event.kind === "stderr") process.stderr.write(Buffer.from(event.data));
			}
		})().catch((error: unknown) => {
			process.stderr.write(`Microsandbox output stream failed: ${error instanceof Error ? error.message : String(error)}\n`);
		});
		await run.wait();
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		if (sandbox && !stopping) await sandbox.stop().catch(() => undefined);
		fs.rmSync(stage, { recursive: true, force: true });
	}
}

async function migratePrivateMemory(config: LoadedConfig): Promise<void> {
	const sourcePath = process.env.ALIVE_SANDBOX_MEMORY_SOURCE || (config.config.memory.databasePath
		? path.resolve(config.paths.rootDir, config.config.memory.databasePath)
		: path.join(config.paths.stateDir, "memory.sqlite"));
	const destinationPath = path.join(config.paths.stateDir, "memory.sqlite");
	if (path.resolve(sourcePath) === path.resolve(destinationPath) || !fs.existsSync(sourcePath)) return;
	const snapshotPath = path.join(config.paths.stateDir, ".memory-migration.sqlite");
	const source = new DatabaseSync(sourcePath, { readOnly: true });
	try {
		await backup(source, snapshotPath);
	} finally {
		source.close();
	}
	const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
	const destination = new DatabaseSync(destinationPath);
	try {
		const tables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alive_memories'").all();
		if (!tables.length) return;
		destination.exec(`CREATE TABLE IF NOT EXISTS alive_memories (
			id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, scopes TEXT NOT NULL,
			created_at TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT,
			active INTEGER NOT NULL DEFAULT 1, supersedes TEXT NOT NULL DEFAULT '[]'
		)`);
		destination.exec("CREATE INDEX IF NOT EXISTS alive_memories_active_idx ON alive_memories (active, valid_from DESC)");
		const permitted = new Set([privateMemoryScope(config), ...sharedMemoryScopes(config)]);
		const insert = destination.prepare("INSERT OR IGNORE INTO alive_memories (id,text,embedding,scopes,created_at,valid_from,valid_to,active,supersedes) VALUES (?,?,?,?,?,?,?,?,?)");
		const rows = snapshot.prepare("SELECT id,text,embedding,scopes,created_at,valid_from,valid_to,active,supersedes FROM alive_memories").all();
		for (const row of rows) {
			const scopes = JSON.parse(String(row.scopes)) as string[];
			if (!scopes.some((scope) => permitted.has(scope))) continue;
			insert.run(row.id, row.text, row.embedding, row.scopes, row.created_at, row.valid_from, row.valid_to, row.active, row.supersedes);
		}
	} finally {
		snapshot.close();
		destination.close();
		fs.rmSync(snapshotPath, { force: true });
		fs.rmSync(`${snapshotPath}-wal`, { force: true });
		fs.rmSync(`${snapshotPath}-shm`, { force: true });
	}
}

function persistPrivateMemoryPath(config: LoadedConfig): void {
	const privatePath = path.join(config.paths.stateDir, "memory.sqlite");
	// alive.config.local.json is merged after the primary config. Persist the
	// override there when present (or create it) so a shared path cannot win on restart.
	const localPath = path.join(path.dirname(config.paths.configPath), "alive.config.local.json");
	const targetPath = fs.existsSync(localPath) ? localPath : config.paths.configPath;
	const raw = JSON.parse(fs.readFileSync(targetPath, "utf8")) as { memory?: { databasePath?: string; sharedScopes?: string[] } };
	if (!raw.memory) raw.memory = {};
	if (path.resolve(config.paths.rootDir, raw.memory.databasePath ?? "") === path.resolve(privatePath)) return;
	raw.memory.databasePath = privatePath;
	const file = `${targetPath}.tmp-${process.pid}`;
	fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	fs.renameSync(file, targetPath);
}

interface ApiSecret {
	envVar: string;
	value: string;
	placeholder: string;
	host: string;
}

interface ModelCredential extends ApiSecret {
	modelSpec: string;
}

async function stageModelCredential(config: LoadedConfig, stage: string): Promise<ModelCredential> {
	const cfg = config.config;
	const authPath = path.join(cfg.piAgentDir, "auth.json");
	const modelsPath = path.join(cfg.piAgentDir, "models.json");
	if (fs.existsSync(modelsPath)) {
		const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
		rejectEmbeddedCredentials(models, "models.json");
		fs.copyFileSync(modelsPath, path.join(stage, "pi-agent", "models.json"), fs.constants.COPYFILE_FICLONE);
	}
	const runtime = await ModelRuntime.create({ authPath, modelsPath });
	const spec = cfg.model.trim() || defaultModelSpec(cfg.piAgentDir);
	if (!spec) throw new Error("Microsandbox requires an explicitly configured model and API-key credential");
	const resolved = resolveCliModel({ cliModel: spec, modelRuntime: runtime });
	if (resolved.error || !resolved.model) throw new Error(`cannot resolve sandbox model: ${resolved.error ?? spec}`);
	if (runtime.isUsingOAuth(resolved.model.provider)) throw new Error("OAuth credentials are not supported in Microsandbox mode; configure a scoped API key");
	const auth = await runtime.getAuth(resolved.model);
	if (!auth?.auth.apiKey) throw new Error(`no API-key credential available for provider ${resolved.model.provider}`);
	if (auth.env && Object.keys(auth.env).length) throw new Error("provider-scoped model auth environment is not supported in Microsandbox mode");
	if (auth.auth.headers && Object.keys(auth.auth.headers).length) throw new Error("custom model auth headers are not supported in Microsandbox mode");
	const endpoint = new URL(auth.auth.baseUrl || resolved.model.baseUrl);
	if (endpoint.protocol !== "https:") throw new Error("sandbox model API must use HTTPS");
	const placeholder = "ALIVE_MICROSANDBOX_MODEL_KEY";
	fs.writeFileSync(path.join(stage, "pi-agent", "auth.json"), `${JSON.stringify({ [resolved.model.provider]: { type: "api_key", key: placeholder } }, null, 2)}\n`, { mode: 0o600 });
	return { envVar: "ALIVE_MODEL_API_KEY", value: auth.auth.apiKey, placeholder, host: endpoint.hostname, modelSpec: spec };
}

function stageEmbeddingCredential(config: LoadedConfig): ApiSecret | undefined {
	const envVar = config.config.memory.embeddingApiKeyEnv;
	const value = process.env[envVar]?.trim();
	if (!value) {
		if (config.config.memory.embeddingProvider === "cloudflare") throw new Error(`missing embedding credential in ${envVar}`);
		return undefined;
	}
	const endpoint = new URL(config.config.memory.embeddingBaseUrl);
	if (endpoint.protocol !== "https:") throw new Error("sandbox embedding API must use HTTPS when an API key is configured");
	if (envVar === "ALIVE_MODEL_API_KEY") throw new Error("memory.embeddingApiKeyEnv conflicts with the model API credential variable");
	return { envVar, value, placeholder: `ALIVE_MICROSANDBOX_${envVar}`, host: endpoint.hostname };
}

function rejectEmbeddedCredentials(value: unknown, location: string): void {
	if (!value || typeof value !== "object") return;
	for (const [key, nested] of Object.entries(value)) {
		if (/(?:api.?key|token|secret|password|authorization|headers?)/i.test(key)) {
			throw new Error(`Microsandbox refuses credential-like field ${location}.${key}; credentials must come from the host Pi auth store`);
		}
		rejectEmbeddedCredentials(nested, `${location}.${key}`);
	}
}
