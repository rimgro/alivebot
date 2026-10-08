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
	channel: process.platform === "linux" && process.arch === "arm64" ? "chromium" : "chrome",
	headless: false,
	viewport: null,
	host: "127.0.0.1",
	port: 4323,
	publicUrl: "",
	notifyChatId: "",
	handoffTtlMs: 10 * 60_000,
	minActionIntervalMs: 500,
	actionTimeoutMs: 15_000,
	humanization: DEFAULT_HUMANIZATION,
	signing: { enabled: false, agentUrl: "", keyFileEnv: "ALIVE_BROWSER_SIGNING_KEY_FILE", origins: [] },
};
