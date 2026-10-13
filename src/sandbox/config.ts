export interface SharedSandboxVolume {
	/** Global microsandbox volume name. Sharing is explicit, not agent-private. */
	name: string;
	mountPath: string;
	readOnly: boolean;
}

export interface SandboxConfig {
	enabled: boolean;
	image: string;
	cpus: number;
	memoryMiB: number;
	/** Numeric guest identity. Offline filesystem access is supported only for root. */
	uid: number;
	gid: number;
	network: boolean;
	/** Public-only egress by default; unrestricted is an explicit operator opt-out. */
	networkAccess: "public" | "unrestricted";
	/** Explicit guest environment only. Never inherits the host environment. */
	env: Record<string, string>;
	offlineFiles: boolean;
	idleTimeoutMs: number;
	checkIntervalMs: number;
	/** Optional private persistent block disk for Docker; never share Docker's data root. */
	dockerDiskMiB: number;
	maxFileBytes: number;
	sharedVolumes: SharedSandboxVolume[];
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	enabled: true,
	image: "python:3.12-slim",
	cpus: 1,
	memoryMiB: 512,
	uid: 0,
	gid: 0,
	network: true,
	networkAccess: "public",
	env: {},
	offlineFiles: true,
	idleTimeoutMs: 5 * 60_000,
	checkIntervalMs: 30_000,
	dockerDiskMiB: 0,
	maxFileBytes: 8 * 1024 * 1024,
	sharedVolumes: [{ name: "alive-shared-resources", mountPath: "/shared", readOnly: true }],
};

export function mergeSandboxConfig(base: SandboxConfig, override: Partial<SandboxConfig> | undefined): SandboxConfig {
	if (override !== undefined && (!override || typeof override !== "object" || Array.isArray(override))) throw new Error("sandbox overrides must be an object");
	return validateSandboxConfig({ ...base, ...override });
}

export function validateSandboxConfig(config: SandboxConfig): SandboxConfig {
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("sandbox must be an object");
	for (const key of Object.keys(config)) {
		if (!Object.hasOwn(DEFAULT_SANDBOX_CONFIG, key)) throw new Error(`Unknown sandbox setting: ${key}`);
	}
	for (const key of ["enabled", "network", "offlineFiles"] as const) {
		if (typeof config[key] !== "boolean") throw new Error(`sandbox.${key} must be boolean`);
	}
	if (config.networkAccess !== "public" && config.networkAccess !== "unrestricted") throw new Error("sandbox.networkAccess must be public or unrestricted");
	if (typeof config.image !== "string" || !config.image.trim()) throw new Error("sandbox.image is required");
	for (const [key, min, max] of [
		["cpus", 1, 256], ["memoryMiB", 128, 1048576], ["uid", 0, 2147483647], ["gid", 0, 2147483647],
		["idleTimeoutMs", 0, 2147483647], ["checkIntervalMs", 1000, 2147483647],
		["dockerDiskMiB", 0, 1048576], ["maxFileBytes", 1024, 64 * 1024 * 1024],
	] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) {
			throw new Error(`sandbox.${key} must be an integer in ${min}..${max}`);
		}
	}
	if (!config.env || typeof config.env !== "object" || Array.isArray(config.env) || Object.keys(config.env).length > 128
		|| Object.entries(config.env).some(([key, value]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || value.length > 8192)) {
		throw new Error("sandbox.env must contain bounded string environment variables (no NUL)");
	}
	if (!Array.isArray(config.sharedVolumes) || config.sharedVolumes.length > 32) throw new Error("sandbox.sharedVolumes must be an array");
	const mounts: string[] = ["/home", "/workspace", "/var/lib/docker"];
	const names = new Set<string>();
	for (const volume of config.sharedVolumes) {
		if (!volume || typeof volume.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(volume.name) || volume.name.startsWith("alive-private-")) {
			throw new Error("shared volume names must be valid and cannot use the alive-private- prefix");
		}
		const mount = volume.mountPath;
		if (typeof mount !== "string" || !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(mount)
			|| ["/proc", "/sys", "/dev", "/etc", "/bin", "/usr", "/sbin", "/run", "/tmp", "/var"].some((p) => mount === p || mount.startsWith(`${p}/`))) {
			throw new Error("shared volumes must use a dedicated absolute mount path (e.g. /shared or /cache/npm)");
		}
		if (typeof volume.readOnly !== "boolean" || names.has(volume.name)
			|| mounts.some((p) => mount === p || mount.startsWith(`${p}/`) || p.startsWith(`${mount}/`))) {
			throw new Error("shared volume names and mount paths must be unique, non-overlapping, with explicit readOnly");
		}
		names.add(volume.name);
		mounts.push(mount);
	}
	return structuredClone(config);
}
