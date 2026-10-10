import type { BrowserContext, CDPSession } from "playwright";
import type { BrowserIdentity } from "./identity.js";

const signatureFields = new Set(["signature", "signature-input", "signature-agent"]);

/** Browser-level CDP interception keeps Chrome's TLS, cookies and request bodies. */
export class BrowserSigningTransport {
	private session?: CDPSession;
	private closed = false;

	constructor(private readonly identity: BrowserIdentity, private readonly onError: (error: unknown) => void) {}

	async start(context: BrowserContext): Promise<void> {
		const browser = context.browser();
		if (!browser) throw new Error("Browser signing requires Chromium CDP");
		const session = await browser.newBrowserCDPSession();
		this.session = session;
		session.on("close", () => { void this.close(); });
		session.on("Fetch.requestPaused", (event: { requestId: string; request: { url: string; method: string; headers: Record<string, string> } }) => {
			void this.continueRequest(session, event).catch(async error => {
				if (!this.closed) this.onError(error);
				await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }).catch(() => {});
			});
		});
		// Browser-level Fetch covers targets before their first request, including
		// popups, out-of-process iframes and dedicated/shared workers.
		await session.send("Fetch.enable", { patterns: [{ urlPattern: "http://*", requestStage: "Request" }, { urlPattern: "https://*", requestStage: "Request" }] });
	}

	async close(): Promise<void> {
		this.closed = true;
		const session = this.session;
		this.session = undefined;
		if (!session) return;
		await boundedCleanup(session.send("Fetch.disable"));
		await boundedCleanup(session.detach());
	}

	private async continueRequest(session: CDPSession, event: { requestId: string; request: { url: string; method: string; headers: Record<string, string> } }): Promise<void> {
		const { request } = event;
		const headers = Object.entries(request.headers).filter(([name]) => !signatureFields.has(name.toLowerCase())).map(([name, value]) => ({ name, value }));
		if (this.identity.authorizes(request.url)) {
			for (const [name, value] of Object.entries(this.identity.requestHeaders(request.url, Date.now(), request.method))) headers.push({ name, value });
		}
		// Overrides apply only to this hop. Sign again after redirects; clear
		// identity headers outside the explicitly authorized HTTPS origins.
		await session.send("Fetch.continueRequest", { requestId: event.requestId, headers });
	}
}

async function boundedCleanup(operation: Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([operation.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
	} finally { clearTimeout(timer); }
}
