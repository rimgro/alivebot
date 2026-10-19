/** Bounded JPEG delivery; input acknowledgements never consume this budget. */
export class StreamPolicy {
	private slow = false;
	private holdUntil = 0;
	private goodAcks = 0;
	private tokens = 80_000;
	private updatedAt: number;
	private sentAt = -Infinity;
	private compression = 0;
	private frameBytes = 0;
	private frameSamples = 0;
	private frameAt = -Infinity;

	constructor(now = performance.now()) { this.updatedAt = now; }

	get profile() {
		const sizes = [
			{ name: "balanced", quality: 42, maxWidth: 900, maxHeight: 800 },
			{ name: "compact", quality: 32, maxWidth: 768, maxHeight: 700 },
			{ name: "compact-small", quality: 26, maxWidth: 640, maxHeight: 600 },
		];
		return this.slow
			? { ...sizes[Math.max(1, this.compression)], name: "economy", fps: 8, bytesPerSecond: 80_000 }
			: { ...sizes[this.compression], fps: 15, bytesPerSecond: 160_000 };
	}

	/** Reduce moving-image size before sacrificing responsiveness to the byte limiter. */
	frame(bytes: number, now = performance.now()): void {
		if (now - this.frameAt > 250) { this.frameSamples = 0; this.frameBytes = 0; }
		this.frameAt = now;
		this.frameBytes = this.frameSamples ? this.frameBytes * .7 + bytes * .3 : bytes;
		if (++this.frameSamples >= 3 && this.compression < 2 && this.frameBytes * 9 > this.profile.bytesPerSecond * 1.15) {
			this.compression++; this.frameSamples = 0; this.frameBytes = 0;
		}
	}

	observe(oldestAckMs: number, bufferedBytes: number, now = performance.now()): void {
		if (oldestAckMs <= 1200 && bufferedBytes <= 128 * 1024) return;
		this.refill(now);
		this.slow = true; this.goodAcks = 0; this.holdUntil = now + 5000;
		this.tokens = Math.min(this.tokens, this.profile.bytesPerSecond / 2);
	}

	ack(ageMs: number, now = performance.now()): void {
		if (ageMs > 800) { this.observe(1201, 0, now); return; }
		if (ageMs <= 400) this.goodAcks++; else this.goodAcks = 0;
		if (this.slow && now >= this.holdUntil && this.goodAcks >= 8) {
			this.refill(now); this.slow = false; this.goodAcks = 0;
		}
	}

	/** One half-second burst also permits a single large readable still, with its full byte debt. */
	canSend(bytes: number, now = performance.now()): boolean {
		this.refill(now);
		return now - this.sentAt >= 1000 / this.profile.fps
			&& this.tokens >= Math.min(bytes, this.profile.bytesPerSecond / 2);
	}

	spend(bytes: number, now = performance.now()): void {
		this.refill(now); this.tokens -= bytes; this.sentAt = now;
	}

	private refill(now: number): void {
		const rate = this.profile.bytesPerSecond;
		this.tokens = Math.min(rate / 2, this.tokens + Math.max(0, now - this.updatedAt) * rate / 1000);
		this.updatedAt = now;
	}
}
