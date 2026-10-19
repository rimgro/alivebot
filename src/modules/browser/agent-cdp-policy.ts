/** Page-scoped CDP used by agent-browser, not an engine-wide CDP connection.
 * Keep this exact allowlist on the host as well as the local adapter. In
 * particular, Network.*Cookies, Storage, Target, uploads and filesystem APIs
 * must never be forwarded to Chromium by a client.
 */
const commands = new Set([
	"Accessibility.enable", "Accessibility.getFullAXTree",
	"DOM.describeNode", "DOM.enable", "DOM.getBoxModel", "DOM.getDocument", "DOM.querySelectorAll", "DOM.resolveNode",
	"Runtime.enable", "Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.runIfWaitingForDebugger", "Runtime.releaseObject", "Runtime.releaseObjectGroup",
	"Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.insertText",
	"Network.enable", "Network.getResponseBody",
	"Page.enable", "Page.bringToFront", "Page.getFrameTree", "Page.getLayoutMetrics", "Page.navigate", "Page.reload",
	"Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument", "Page.handleJavaScriptDialog",
	"Page.captureScreenshot", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck",
	"Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
]);
export function assertAgentCdpCommand(method: string, params: Record<string, unknown> = {}): void {
	if (!commands.has(method)) throw new Error("This CDP command is unavailable on a shared host");
	if (method === "Page.navigate") assertBrowserUrl(params.url);
}
export function assertBrowserUrl(value: unknown): asserts value is string {
	if (value !== "about:blank" && (typeof value !== "string" || !/^https?:\/\//i.test(value))) throw new Error("Shared navigation requires an HTTP(S) URL or about:blank");
}
