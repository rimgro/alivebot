import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../config.js";
import { appProfileFor, getScopedInstallationToken } from "./app-auth.js";
import { withRetries, type RetryLogger } from "../retry.js";

const REPOSITORY = "rimgro/alivebot";
const API = "https://api.github.com";

type Action = "list_issues" | "get_issue" | "create_issue" | "update_issue" | "comment_issue"
	| "list_pull_requests" | "get_pull_request" | "create_pull_request" | "update_pull_request" | "comment_pull_request";

function success(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function compactIssue(value: any) {
	return { number: value.number, title: value.title, state: value.state, state_reason: value.state_reason,
		labels: value.labels?.map((label: any) => typeof label === "string" ? label : label.name),
		assignees: value.assignees?.map((assignee: any) => assignee.login), url: value.html_url, updated_at: value.updated_at,
		...(value.pull_request ? { pull_request: true } : {}) };
}

function compactPull(value: any) {
	return { number: value.number, title: value.title, state: value.state, draft: value.draft,
		head: value.head?.ref, base: value.base?.ref, url: value.html_url, updated_at: value.updated_at };
}

export function createGitHubApiTool(loaded: LoadedConfig, log?: RetryLogger): ToolDefinition | undefined {
	if (!appProfileFor(loaded)) return undefined;
	return defineTool({
		name: "github_api",
		label: "GitHub issues and pull requests",
		description: `Use this restricted GitHub API for issues and PRs in ${REPOSITORY} only. It uses your GitHub App's short-lived installation token internally; credentials are never returned. Actions: list/get/create/update/comment issues and list/get/create/update/comment PRs. Permission limits are enforced by GitHub.`,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list_issues"), Type.Literal("get_issue"), Type.Literal("create_issue"), Type.Literal("update_issue"), Type.Literal("comment_issue"),
				Type.Literal("list_pull_requests"), Type.Literal("get_pull_request"), Type.Literal("create_pull_request"), Type.Literal("update_pull_request"), Type.Literal("comment_pull_request"),
			]),
			number: Type.Optional(Type.Integer({ minimum: 1 })),
			state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")])),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
			body: Type.Optional(Type.String({ maxLength: 65536 })),
			labels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 100 })),
			assignees: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 39 }), { maxItems: 10 })),
			milestone: Type.Optional(Type.Integer({ minimum: 1 })),
			state_reason: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("not_planned")])),
			head: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
			base: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
			draft: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal) {
			signal?.throwIfAborted();
			const action = params.action as Action;
			const { token } = await getScopedInstallationToken(loaded, signal, log);
			const send = async (endpoint: string, method: string, payload?: Record<string, unknown>) => {
				const response = await fetch(`${API}${endpoint}`, {
					method,
					headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "alive-github-api-tool", "x-github-api-version": "2022-11-28", ...(payload ? { "content-type": "application/json" } : {}) },
					...(payload ? { body: JSON.stringify(payload) } : {}),
					signal,
				});
				const data = await response.json().catch((): Record<string, any> => ({})) as Record<string, any>;
				if (!response.ok) {
					const message = typeof data.message === "string" ? data.message.slice(0, 500) : "unknown GitHub API error";
					const error = new Error(`GitHub ${method} ${endpoint} failed (${response.status}): ${message}`);
					// Status lets the shared classifier retry 5xx/429 and stop on 401/403/422.
					Object.assign(error, { status: response.status });
					throw error;
				}
				return data;
			};
			// Reads are safe to repeat; a repeated write could create a duplicate issue,
			// PR or comment, so only GET stays retryable.
			const request = async (endpoint: string, method = "GET", payload?: Record<string, unknown>) =>
				method === "GET"
					? withRetries(() => send(endpoint, method, payload), { attempts: 3, baseDelayMs: 500, maxDelayMs: 5_000, label: "github api", log, signal })
					: send(endpoint, method, payload);
			const number = params.number as number | undefined;
			const requireNumber = () => { if (!Number.isSafeInteger(number) || number! < 1) throw new Error(`${action} requires a positive issue/PR number`); return number!; };
			const issueEndpoint = (n: number) => `/repos/${REPOSITORY}/issues/${n}`;
			const pullEndpoint = (n: number) => `/repos/${REPOSITORY}/pulls/${n}`;

			switch (action) {
				case "list_issues": {
					const state = params.state ?? "open";
					const rows = await request(`/repos/${REPOSITORY}/issues?state=${state}&per_page=100`);
					const issues = (rows as any[]).filter((row) => !row.pull_request).map(compactIssue);
					return success(JSON.stringify(issues, null, 2), { repository: REPOSITORY, count: issues.length });
				}
				case "get_issue": {
					const issue = await request(issueEndpoint(requireNumber()));
					if ((issue as any).pull_request) throw new Error(`Issue #${number} is a pull request; use get_pull_request`);
					return success(JSON.stringify(issue, null, 2), { repository: REPOSITORY, number });
				}
				case "create_issue": {
					if (!params.title?.trim()) throw new Error("create_issue requires a non-empty title");
					const payload: Record<string, unknown> = { title: params.title.trim() };
					for (const key of ["body", "labels", "assignees", "milestone"] as const) if (params[key] !== undefined) payload[key] = params[key];
					const issue = await request(`/repos/${REPOSITORY}/issues`, "POST", payload);
					return success(`Created issue #${(issue as any).number}: ${(issue as any).html_url}`, compactIssue(issue));
				}
				case "update_issue": {
					const payload: Record<string, unknown> = {};
					for (const key of ["title", "body", "state", "labels", "assignees", "milestone", "state_reason"] as const) if (params[key] !== undefined) payload[key] = params[key];
					if (!Object.keys(payload).length) throw new Error("update_issue requires at least one update field");
					const issue = await request(issueEndpoint(requireNumber()), "PATCH", payload);
					return success(`Updated issue #${(issue as any).number}: ${(issue as any).html_url}`, compactIssue(issue));
				}
				case "comment_issue":
				case "comment_pull_request": {
					if (!params.body?.trim()) throw new Error(`${action} requires a non-empty body`);
					const comment = await request(`${issueEndpoint(requireNumber())}/comments`, "POST", { body: params.body });
					return success(`Comment added to #${number}: ${(comment as any).html_url}`, { repository: REPOSITORY, number, url: (comment as any).html_url });
				}
				case "list_pull_requests": {
					const state = params.state ?? "open";
					const rows = await request(`/repos/${REPOSITORY}/pulls?state=${state}&per_page=100`);
					const pulls = (rows as any[]).map(compactPull);
					return success(JSON.stringify(pulls, null, 2), { repository: REPOSITORY, count: pulls.length });
				}
				case "get_pull_request": {
					const pull = await request(pullEndpoint(requireNumber()));
					return success(JSON.stringify(pull, null, 2), { repository: REPOSITORY, number });
				}
				case "create_pull_request": {
					if (!params.title?.trim() || !params.head?.trim() || !params.base?.trim()) throw new Error("create_pull_request requires title, head and base");
					const payload: Record<string, unknown> = { title: params.title.trim(), head: params.head.trim(), base: params.base.trim() };
					for (const key of ["body", "draft"] as const) if (params[key] !== undefined) payload[key] = params[key];
					const pull = await request(`/repos/${REPOSITORY}/pulls`, "POST", payload);
					return success(`Created PR #${(pull as any).number}: ${(pull as any).html_url}`, compactPull(pull));
				}
				case "update_pull_request": {
					const payload: Record<string, unknown> = {};
					for (const key of ["title", "body", "state", "base"] as const) if (params[key] !== undefined) payload[key] = params[key];
					if (!Object.keys(payload).length) throw new Error("update_pull_request requires at least one update field");
					const pull = await request(pullEndpoint(requireNumber()), "PATCH", payload);
					return success(`Updated PR #${(pull as any).number}: ${(pull as any).html_url}`, compactPull(pull));
				}
			}
		},
	});
}
