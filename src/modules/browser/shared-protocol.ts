import { assertAgentCdpCommand } from "./agent-cdp-policy.js";

interface Packet { id?: number; guid?: string; method?: string; params?: Record<string, any>; result?: Record<string, any> }

/** The remote server scopes SDK objects; this gate removes browser-wide and server-filesystem escape hatches. */
export class SharedProtocol {
	private objects = new Map<string, string>([["", "Root"]]);
	private pending = new Map<number, string>();
	private windows = new Set<number>();
	private contexts = 0;
	private pages = new Set<string>();

	server(packet: Packet): void {
		if (packet.method === "__create__") {
			const { guid, type } = packet.params || {};
			if (typeof guid === "string" && typeof type === "string") {
				this.objects.set(guid, type);
				if (type === "Page") { this.pages.add(guid); if (this.pages.size > 8) throw new Error("Too many pages in this shared session"); }
			}
		}
		if (packet.method === "__dispose__" && packet.guid) { this.objects.delete(packet.guid); this.pages.delete(packet.guid); }
		if (packet.id !== undefined) {
			const method = this.pending.get(packet.id); this.pending.delete(packet.id);
			if (method === "Browser.getWindowForTarget" && Number.isInteger(packet.result?.value?.windowId)) this.windows.add(packet.result!.value.windowId);
		}
	}

	client(packet: Packet): string {
		if (!Number.isSafeInteger(packet.id) || typeof packet.guid !== "string" || typeof packet.method !== "string") throw new Error("Invalid shared browser packet");
		const type = this.objects.get(packet.guid), method = packet.method, params = packet.params || {};
		const allowedObjects = new Set(["Root", "Playwright", "BrowserType", "Browser", "BrowserContext", "Page", "Frame", "ElementHandle", "JSHandle", "Request", "Response", "Route", "CDPSession", "Worker", "WebSocket", "WebSocketRoute", "APIRequestContext", "Selectors"]);
		if (!type || !allowedObjects.has(type)) throw new Error("Shared browser object is unavailable");
		if (["setInputFiles", "createTempFiles", "newContextForReuse", "disconnectFromReusedContext", "startTracing", "stopTracing", "newBrowserCDPSession", "startServer", "stopServer", "killForTests", "enableRecorder", "pause"].includes(method)) throw new Error("Browser-wide and server-file operations are unavailable on a shared host");
		if (type === "BrowserType") throw new Error("Only the pre-launched shared browser is available");
		if (type === "Playwright") throw new Error("The shared host does not launch auxiliary processes or API clients");
		if (type === "Frame" && method === "goto" && params.url !== "about:blank" && !/^https?:\/\//i.test(params.url || "")) throw new Error("Shared navigation requires an HTTP(S) URL or about:blank");
		if (type === "APIRequestContext") {
			if (!["fetch", "fetchResponseBody", "disposeAPIResponse", "storageState"].includes(method)) throw new Error("Only read-only API requests are available on a shared host");
			if (method === "fetch" && (!["GET", "HEAD"].includes(params.method || "GET") || params.multipartData || params.formData || params.postData)) throw new Error("Only read-only API requests are available on a shared host");
		}
		if (type === "Browser") {
			if (!["newContext", "close"].includes(method)) throw new Error("Shared browser operation is unavailable");
			if (method === "newContext") {
				if (this.contexts >= 1) throw new Error("Use one isolated context per shared browser connection");
				const allowed = new Set(["viewport", "noDefaultViewport", "storageState", "acceptDownloads", "serviceWorkers", "isMobile", "hasTouch", "deviceScaleFactor", "ignoreHTTPSErrors", "selectorEngines"]);
				const unknown = Object.keys(params).filter(key => !allowed.has(key));
				if (unknown.length || params.acceptDownloads !== "deny") throw new Error(`Unsupported shared context options${unknown.length ? `: ${unknown.join(", ")}` : "; downloads must be denied"}`);
				this.contexts++;
			}
		}
		if (type === "BrowserContext" && method === "newPage" && this.pages.size >= 8) throw new Error("Too many pages in this shared browser session");
		if (type === "CDPSession" && method === "send") {
			const command = params.method;
			if (!["Browser.getWindowForTarget", "Browser.setContentsSize"].includes(command)) assertAgentCdpCommand(command, params.params);
			if (command === "Browser.getWindowForTarget" && Object.keys(params.params || {}).length) throw new Error("Only the current page window is available");
			if (command === "Browser.setContentsSize" && !this.windows.has(params.params?.windowId)) throw new Error("This browser window does not belong to the connection");
			if (command === "Browser.getWindowForTarget") this.pending.set(packet.id!, command);
		}
		return type;
	}
}
