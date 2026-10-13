import { randomInt } from "node:crypto";
import type { Locator, Page } from "playwright";
import { sleep } from "../../util.js";
import type { HumanizationConfig } from "./config.js";

/** Native pointer/key events with bounded delays, without invoking controls in JavaScript. */
export class HumanActions {
	private positions = new WeakMap<Page, { x: number; y: number }>();
	constructor(private readonly config: HumanizationConfig) {}

	async before(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.config.enabled) await this.wait(this.random(this.config.minDelayMs, this.config.maxDelayMs), signal);
	}

	async click(page: Page, target: Locator, signal: AbortSignal): Promise<void> {
		if (!this.config.enabled) { signal.throwIfAborted(); await target.click(); return; }
		await target.scrollIntoViewIfNeeded();
		const box = await target.boundingBox();
		if (!box) throw new Error("Target has no visible bounding box");
		const position = { x: box.width * this.random(35, 65) / 100, y: box.height * this.random(35, 65) / 100 };
		const end = { x: box.x + position.x, y: box.y + position.y };
		const start = this.positions.get(page) ?? { x: Math.max(0, end.x - 100), y: Math.max(0, end.y - 60) };
		const steps = this.random(10, 18), curve = this.random(-30, 30);
		for (let index = 1; index <= steps; index++) {
			const t = index / steps, eased = t * t * (3 - 2 * t);
			await this.wait(this.random(8, 20), signal);
			await page.mouse.move(start.x + (end.x - start.x) * eased, Math.max(0, start.y + (end.y - start.y) * eased + Math.sin(Math.PI * t) * curve));
		}
		signal.throwIfAborted();
		// Preserve locator actionability checks after moving the pointer to its destination.
		await target.click({ position, delay: this.random(45, 110) });
		this.positions.set(page, end);
	}

	async fill(page: Page, target: Locator, text: string, signal: AbortSignal): Promise<void> {
		if (text.length > 4096) throw new Error("Browser text is limited to 4096 characters");
		if (!this.config.enabled) { signal.throwIfAborted(); await target.fill(text); return; }
		await this.click(page, target, signal);
		signal.throwIfAborted();
		await target.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
		signal.throwIfAborted();
		await target.press("Backspace");
		for (const character of text) {
			await this.wait(this.random(this.config.minTypingDelayMs, this.config.maxTypingDelayMs), signal);
			await target.pressSequentially(character);
		}
	}

	async scroll(page: Page, delta: number, signal: AbortSignal): Promise<void> {
		if (!this.config.enabled) { signal.throwIfAborted(); await page.mouse.wheel(0, delta); return; }
		let remaining = delta;
		while (remaining !== 0) {
			await this.wait(this.random(45, 120), signal);
			const step = Math.sign(remaining) * Math.min(Math.abs(remaining), this.random(100, 250));
			await page.mouse.wheel(0, step);
			remaining -= step;
		}
	}

	private random(min: number, max: number): number { return randomInt(min, max + 1); }
	private async wait(delay: number, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		await sleep(delay, signal);
		signal.throwIfAborted();
	}
}
