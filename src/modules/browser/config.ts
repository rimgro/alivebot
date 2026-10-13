export interface BrowserSigningConfig {
	enabled: boolean;
	agentUrl: string;
	/** Environment variable containing the path to an Ed25519 PEM private key. */
	keyFileEnv: string;
	/** Exact HTTPS origins to which the operator permits signed HTTP requests. */
	origins: string[];
}

export interface BrowserConfig {
	enabled: boolean;
	driver: "patchright" | "playwright";
	/** Explicit managed engine. A requested Fortress never silently falls back to Chrome. */
	engine: "chrome" | "fortress";
	/** Official, immutable Docker image; used when no native Fortress executable is configured. */
	fortressImage: string;
	fortressLicenseFileEnv: string;
	/** Refuse the silent first-generation mode for production Fortress setup. */
	fortressRequireLicense: boolean;
	/** Empty launches Chrome; otherwise attach to the loopback CDP URL in this env var. */
	cdpEndpointEnv: string;
	/** Optional trusted Chromium/Fortress executable. Managed profiles remain per conversation. */
	executablePathEnv: string;
	/** Native launches minimize framework startup flags; auto selects native for headed Chrome. */
	launchMode: "auto" | "driver" | "native";
	/** Let an unsigned initial navigation run before attaching the automation client. */
	nativeWarmupMs: number;
	channel: "chrome" | "chromium";
	headless: boolean;
	/** null preserves native window dimensions. */
	viewport: { width: number; height: number } | null;
	host: string;
	port: number;
	/** HTTPS origin of the reverse proxy; empty uses the local listener. */
	publicUrl: string;
	/** Explicit operator destination; empty uses the privately paired operator. */
	notifyChatId: string;
	handoffTtlMs: number;
	/** Minimum spacing between agent actions, for workload control. */
	minActionIntervalMs: number;
	/** Minimum interval between agent navigations/API requests to the same origin. */
	minNavigationIntervalMs: number;
	/** Maximum passive wait for a known automatic browser check before human handoff. */
	challengeWaitMs: number;
	actionTimeoutMs: number;
	humanization: HumanizationConfig;
	signing: BrowserSigningConfig;
}

export interface HumanizationConfig {
	enabled: boolean;
	minDelayMs: number;
	maxDelayMs: number;
	minTypingDelayMs: number;
	maxTypingDelayMs: number;
}

export const DEFAULT_HUMANIZATION: HumanizationConfig = {
	enabled: true, minDelayMs: 120, maxDelayMs: 350,
	minTypingDelayMs: 25, maxTypingDelayMs: 75,
};

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
	enabled: false,
	driver: "patchright",
	engine: "chrome",
	fortressImage: "tilion/fortress@sha256:6c275b96f96199f48ab7ca05366898cdf796ac1da8cb5cceb936a4ce98e41b4e",
	fortressLicenseFileEnv: "ALIVE_FORTRESS_LICENSE_FILE",
	fortressRequireLicense: true,
	cdpEndpointEnv: "",
	executablePathEnv: "",
	launchMode: "auto",
	nativeWarmupMs: 10_000,
	channel: process.platform === "linux" && process.arch === "arm64" ? "chromium" : "chrome",
	headless: false,
	viewport: null,
	host: "127.0.0.1",
	port: 4323,
	publicUrl: "",
	notifyChatId: "",
	handoffTtlMs: 10 * 60_000,
	minActionIntervalMs: 500,
	minNavigationIntervalMs: 2000,
	challengeWaitMs: 15_000,
	actionTimeoutMs: 15_000,
	humanization: DEFAULT_HUMANIZATION,
	signing: { enabled: false, agentUrl: "", keyFileEnv: "ALIVE_BROWSER_SIGNING_KEY_FILE", origins: [] },
};
