import { setTimeout as delay } from "node:timers/promises";
import type { Page, Request } from "playwright";
import { withDeadline } from "./extract.js";

interface Failure { origin: string; type: string; status?: number; code?: string }
interface Observation { pending: Set<Request>; failures: Failure[]; scriptErrors: number }

/** Bounded response metadata only; never retains headers, bodies or console messages. */
export class BrowserObservation {
	private pages = new WeakMap<Page, Observation>();
	attach(page: Page): void {
		if (this.pages.has(page)) return;
		this.reset(page);
		page.on("request", request => {
			if (!["document", "xhr", "fetch", "script"].includes(request.resourceType())) return;
			const state = this.pages.get(page)!;
			if (state.pending.size < 256) state.pending.add(request);
		});
		page.on("requestfinished", request => this.pages.get(page)!.pending.delete(request));
		page.on("requestfailed", request => {
			const state = this.pages.get(page)!;
			if (!state.pending.delete(request)) return;
			this.failure(page, request, { code: request.failure()?.errorText.match(/net::[A-Z0-9_]+/)?.[0] || "request-failed" });
		});
		page.on("response", response => {
			if (response.status() >= 400 && this.pages.get(page)!.pending.has(response.request())) this.failure(page, response.request(), { status: response.status() });
		});
		page.on("pageerror", () => this.pages.get(page)!.scriptErrors++);
	}
	reset(page: Page): void { this.pages.set(page, { pending: new Set(), failures: [], scriptErrors: 0 }); }
	summary(page: Page): Record<string, unknown> {
		const state = this.pages.get(page);
		return { pendingContentRequests: state?.pending.size ?? 0, failures: state?.failures ?? [], scriptErrors: state?.scriptErrors ?? 0, note: "Observed after attachment; some drivers suppress pageerror events, so zero is not proof of no script errors. HTTP 200 and an empty shell do not establish catalog readiness or a block." };
	}
	private failure(page: Page, request: Request, detail: Pick<Failure, "status" | "code">): void {
		let origin: string; try { origin = new URL(request.url()).origin; } catch { return; }
		const state = this.pages.get(page)!;
		state.failures.push({ origin, type: request.resourceType(), ...detail });
		if (state.failures.length > 20) state.failures.shift();
	}
}

export interface CatalogContent { state: "ready" | "empty" | "unconfirmed"; productLinks: number; waitedMs: number; expectation: string }

/** Matched inside the renderer; only the boolean result crosses CDP. */
const EMPTY_STATE_PATTERN = "ничего не (нашлось|найдено)|по вашему запросу[^\\n]{0,100}(нет|не найден)|товары не найдены";
/** Runs in the page so an empty-state check never transfers the whole catalog text. */
export function catalogEmptyStateExtractor(element: { innerText?: string | null; textContent?: string | null }, pattern: string): boolean {
	const value = typeof element.innerText === "string" ? element.innerText : element.textContent ?? "";
	return new RegExp(pattern, "i").test(value);
}

/** Wait for the reported public catalog's actual cards or explicit empty state, not networkidle. */
export async function waitCatalogContent(page: Page, timeoutMs: number, signal: AbortSignal, guard: () => Promise<void>): Promise<CatalogContent | undefined> {
	const url = new URL(page.url());
	if (url.hostname !== "www.wildberries.ru" || url.pathname !== "/catalog/0/search.aspx") return undefined;
	const started = Date.now();
	// At most one empty-state probe is in flight: a probe abandoned at its
	// deadline settles on its own instead of piling up on a heavy renderer.
	let probe: Promise<boolean> | undefined;
	while (true) {
		signal.throwIfAborted(); await guard(); signal.throwIfAborted();
		const current = new URL(page.url());
		if (current.origin !== url.origin || current.pathname !== url.pathname || current.search !== url.search) return { state: "unconfirmed", productLinks: 0, waitedMs: Date.now() - started, expectation: "The search page changed while awaiting its catalog." };
		const links = await page.locator('main a[href*="/catalog/"][href*="/detail.aspx"], .product-card a[href*="/detail.aspx"]').count();
		const elapsed = Date.now() - started;
		if (links) return { state: "ready", productLinks: links, waitedMs: elapsed, expectation: "Rendered catalog product links; verify each item's details and price separately." };
		const main = page.locator("main, [role=main]").first();
		// The check runs in the renderer and is deadline-bounded; a slow heavy page
		// is treated as "not empty yet" instead of stalling the read.
		let empty = false;
		if (await main.count()) {
			probe ??= (async () => {
				try { return await main.evaluate(catalogEmptyStateExtractor, EMPTY_STATE_PATTERN); }
				catch { return false; }
				finally { probe = undefined; }
			})();
			try { empty = await withDeadline(() => probe!, 2_000, signal); }
			catch (error) { if (signal.aborted) throw error; }
		}
		if (empty) return { state: "empty", productLinks: 0, waitedMs: elapsed, expectation: "The rendered page explicitly reports no search results." };
		if (elapsed >= timeoutMs) return { state: "unconfirmed", productLinks: 0, waitedMs: elapsed, expectation: "No product links or explicit empty state observed. Inspect snapshot, screenshot and network diagnostics; do not infer a block. Keep the page for operator assistance if needed." };
		await delay(Math.min(200, timeoutMs - elapsed), undefined, { signal });
	}
}
