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
	channel: "chrome" | "chromium";
	headless: boolean;
	host: string;
	port: number;
	/** HTTPS origin of the reverse proxy; empty uses the local listener. */
	publicUrl: string;
	/** Explicit operator destination; empty disables Telegram notifications. */
	notifyChatId: string;
	handoffTtlMs: number;
	/** Minimum spacing between agent actions, for workload control. */
	minActionIntervalMs: number;
	actionTimeoutMs: number;
	signing: BrowserSigningConfig;
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
	enabled: false,
	channel: "chrome",
	headless: false,
	host: "127.0.0.1",
	port: 4323,
	publicUrl: "",
	notifyChatId: "",
	handoffTtlMs: 10 * 60_000,
	minActionIntervalMs: 500,
	actionTimeoutMs: 15_000,
	signing: { enabled: false, agentUrl: "", keyFileEnv: "ALIVE_BROWSER_SIGNING_KEY_FILE", origins: [] },
};
