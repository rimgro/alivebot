import * as http from "node:http";
import type { GrafanaConfig } from "../../config.js";
import type { AliveModule, ModuleContext } from "../../events/api.js";
import type { EventPriority } from "../../store/events.js";

const MAX_BODY_BYTES = 512 * 1024;

interface GrafanaAlert {
	status?: string;
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	startsAt?: string;
	endsAt?: string;
	generatorURL?: string;
	fingerprint?: string;
	values?: Record<string, number | string>;
}

interface GrafanaPayload {
	status?: string;
	title?: string;
	message?: string;
	alerts?: GrafanaAlert[];
	commonLabels?: Record<string, string>;
	commonAnnotations?: Record<string, string>;
	groupLabels?: Record<string, string>;
	externalURL?: string;
	state?: string;
	version?: string;
}

/**
 * Grafana (and generic webhook) inbound module.
 *
 * Grafana alerting can POST to a webhook contact point; this module exposes one
 * and turns each alert into an `observability` event for the agent. It is also a
 * worked example of an **inbound-only** module: no outbound handler, no chat
 * thread of its own — just `ctx.event(...)`, shared history, and a status
 * contribution. Compare it with the Telegram module to see the whole API used
 * (inbound + outbound + tools) and this one to see the minimum.
 *
 * Endpoints (all under `modules.grafana.path`, default `/grafana`):
 *   POST <path>/alert   Grafana alerting webhook payload
 *   POST <path>/event   { title, text, priority?, thread?, payload?, dedupe_key? }
 *   GET  <path>/health  liveness probe
 */
export class GrafanaModule implements AliveModule {
	readonly name = "grafana";
	readonly kind = "events" as const;

	private readonly config: GrafanaConfig;
	private ctx?: ModuleContext;
	private server?: http.Server;
	private lastError?: string;
	private lastReceivedAt?: number;
	private received = 0;
	private requests = 0;
	private readonly counters = new Map<string, number>();

	constructor(config: GrafanaConfig) {
		this.config = config;
	}

	async start(ctx: ModuleContext): Promise<void> {
		this.ctx = ctx;
		ctx.contributeStatus(() => this.status());
		const base = normalizePath(this.config.path);
		this.server = http.createServer((req, res) => {
			void this.handle(base, req, res).catch((err) => {
				this.lastError = message(err);
				ctx.log.error("grafana request failed", { error: this.lastError });
				sendJson(res, 500, { error: "internal error" });
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.config.port, this.config.host, () => resolve());
		});
		ctx.log.info("grafana webhook listening", {
			url: `http://${this.config.host}:${this.config.port}${base}`,
		});
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	status(): Record<string, unknown> {
		return {
			listening: this.server !== undefined,
			url: this.server ? `http://${this.config.host}:${this.config.port}${normalizePath(this.config.path)}` : undefined,
			requests: this.requests,
			received: this.received,
			lastReceivedAt: this.lastReceivedAt,
			lastError: this.lastError,
			byStatus: Object.fromEntries(this.counters),
		};
	}

	private async handle(base: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (req.method === "GET" && url.pathname === `${base}/health`) {
			return sendJson(res, 200, { ok: true, module: "grafana", received: this.received });
		}
		if (!this.authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
		if (req.method === "POST" && url.pathname === `${base}/alert`) {
			const payload = (await readJsonBody(req)) as GrafanaPayload;
			const ids = this.ingestAlertPayload(payload);
			this.requests += 1;
			this.lastReceivedAt = Date.now();
			return sendJson(res, 202, { ok: true, accepted: ids.length, ids });
		}
		if (req.method === "POST" && url.pathname === `${base}/event`) {
			const payload = (await readJsonBody(req)) as Record<string, unknown>;
			const id = this.ingestGenericEvent(payload);
			this.requests += 1;
			this.lastReceivedAt = Date.now();
			return sendJson(res, 202, { ok: true, ids: [id] });
		}
		return sendJson(res, 404, { error: "not found" });
	}

	private ingestAlertPayload(payload: GrafanaPayload): string[] {
		const ctx = this.requireCtx();
		const ids: string[] = [];
		const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
		if (alerts.length === 0) {
			const status = payload.status ?? payload.state ?? "unknown";
			const title = payload.title ?? `Grafana ${status}`;
			const text = payload.message ?? title;
			const event = ctx.event({
				kind: "observability",
				priority: this.priorityFor(status),
				title,
				text,
				payload,
				dedupeKey: `grafana:${hash(`${title}:${text}:${status}`)}`,
				meta: { source: "grafana", status },
			});
			this.record(status);
			this.recordHistory(ctx, event.id, title, text, status);
			ids.push(event.id);
			return ids;
		}

		for (const alert of alerts) {
			const labels = { ...(payload.commonLabels ?? {}), ...(alert.labels ?? {}) };
			const annotations = { ...(payload.commonAnnotations ?? {}), ...(alert.annotations ?? {}) };
			const status = alert.status ?? payload.status ?? "unknown";
			const name = labels.alertname ?? "alert";
			const severity = labels.severity ?? "unspecified";
			const title = `Grafana ${status.toUpperCase()}: ${name} (${severity})`;
			const text = describeAlert(title, labels, annotations, alert, payload);
			const thread = labels.thread ?? annotations.thread;
			const fingerprint = alert.fingerprint ?? hash(JSON.stringify(labels));
			const stamp = status === "resolved" ? alert.endsAt ?? alert.startsAt ?? "" : alert.startsAt ?? "";
			const event = ctx.event({
				kind: "observability",
				priority: this.priorityFor(status),
				title,
				text,
				thread,
				expectsReply: false,
				payload: {
					module: "grafana",
					status,
					labels,
					annotations,
					startsAt: alert.startsAt,
					endsAt: alert.endsAt,
					generatorURL: alert.generatorURL,
					fingerprint,
					values: alert.values,
					externalURL: payload.externalURL,
				},
				dedupeKey: `grafana:${fingerprint}:${status}:${stamp}`,
				ts: alert.startsAt ? safeTime(alert.startsAt) : undefined,
				meta: { source: "grafana", status, severity, alertname: name, fingerprint },
			});
			this.record(status);
			this.recordHistory(ctx, event.id, title, text, status, thread, name);
			if (thread) ctx.history.upsertThread({ thread, module: "grafana", title: `Grafana alerts (${thread})` });
			ids.push(event.id);
		}
		return ids;
	}

	private ingestGenericEvent(payload: Record<string, unknown>): string {
		const ctx = this.requireCtx();
		const title = typeof payload.title === "string" ? payload.title : "Grafana event";
		const text = typeof payload.text === "string" ? payload.text : JSON.stringify(payload, null, 2);
		const status = typeof payload.status === "string" ? payload.status : "event";
		const priority = normalizePriority(payload.priority) ?? this.priorityFor(status);
		const thread = typeof payload.thread === "string" ? payload.thread : undefined;
		const dedupeKey =
			typeof payload.dedupe_key === "string" ? `grafana:${payload.dedupe_key}` : `grafana:evt:${hash(`${title}:${text}`)}`;
		const event = ctx.event({
			kind: "observability",
			priority,
			title,
			text,
			thread,
			payload,
			dedupeKey,
			meta: { source: "grafana", status },
		});
		this.record(status);
		this.recordHistory(ctx, event.id, title, text, status, thread);
		return event.id;
	}

	private recordHistory(
		ctx: ModuleContext,
		eventId: string,
		title: string,
		text: string,
		status: string,
		thread = "grafana",
		alertname?: string,
	): void {
		ctx.history.append({
			id: `grafana:${eventId}`,
			thread,
			module: "grafana",
			direction: "inbound",
			text,
			author: "grafana",
			meta: { eventId, title, status, alertname },
		});
	}

	private priorityFor(status: string): EventPriority {
		const normalized = status.toLowerCase();
		if (normalized === "resolved" || normalized === "ok" || normalized === "normal") return this.config.resolvedPriority;
		if (normalized === "firing" || normalized === "alerting" || normalized === "critical" || normalized === "error") {
			return this.config.firingPriority;
		}
		return this.config.firingPriority;
	}

	private record(status: string): void {
		this.received += 1;
		this.counters.set(status, (this.counters.get(status) ?? 0) + 1);
	}

	private authorized(req: http.IncomingMessage): boolean {
		const token = this.config.token;
		if (!token) return true;
		const header = req.headers.authorization;
		const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
		const direct = req.headers["x-alive-token"];
		return bearer === token || direct === token;
	}

	private requireCtx(): ModuleContext {
		if (!this.ctx) throw new Error("grafana module is not started");
		return this.ctx;
	}
}

function describeAlert(
	title: string,
	labels: Record<string, string>,
	annotations: Record<string, string>,
	alert: GrafanaAlert,
	payload: GrafanaPayload,
): string {
	const lines = [title];
	if (annotations.summary) lines.push(`summary: ${annotations.summary}`);
	if (annotations.description) lines.push(`description: ${annotations.description}`);
	const labelText = Object.entries(labels)
		.filter(([key]) => key !== "alertname" && key !== "severity")
		.map(([key, value]) => `${key}=${value}`)
		.join(", ");
	if (labelText) lines.push(`labels: ${labelText}`);
	if (alert.values && Object.keys(alert.values).length > 0) {
		lines.push(`values: ${Object.entries(alert.values).map(([key, value]) => `${key}=${value}`).join(", ")}`);
	}
	if (alert.startsAt) lines.push(`startsAt: ${alert.startsAt}`);
	if (alert.endsAt) lines.push(`endsAt: ${alert.endsAt}`);
	if (alert.generatorURL) lines.push(`source: ${alert.generatorURL}`);
	if (payload.externalURL) lines.push(`grafana: ${payload.externalURL}`);
	return lines.join("\n");
}

function normalizePath(value: string): string {
	const trimmed = (value || "/grafana").trim();
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	return withSlash.replace(/\/+$/, "") || "/grafana";
}

function normalizePriority(value: unknown): EventPriority | undefined {
	if (value === "low" || value === "normal" || value === "high" || value === "interrupt") return value;
	return undefined;
}

function safeTime(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function hash(value: string): string {
	let h = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("body too large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return {};
	return JSON.parse(raw) as unknown;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
	const body = `${JSON.stringify(value, null, 2)}\n`;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
