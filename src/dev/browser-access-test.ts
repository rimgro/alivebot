import assert from "node:assert/strict";
import { BrowserNavigationBudget, retryDeadline } from "../modules/browser/access.js";
import { resolveBrowserExecutable } from "../modules/browser/connection.js";

const now = 1_700_000_000_000;
assert.equal(retryDeadline({ "retry-after": "3" }, now), now + 3000);
assert.equal(retryDeadline({ "retry-after": new Date(now + 4000).toUTCString() }, now), now + 4000);
assert.equal(retryDeadline({ "x-ratelimit-retry": "2.5" }, now), now + 2500);
assert.equal(retryDeadline({ "retry-after": "invalid", "x-ratelimit-retry": "2" }, now), now + 2000);
assert.equal(retryDeadline({ "retry-after": "1e100", "x-ratelimit-retry": "-1" }, now), now + 60_000);
assert.equal(retryDeadline({ "retry-after": "9".repeat(400) }, now), now + 60_000);

const signal = new AbortController().signal;
const budget = new BrowserNavigationBudget(120);
const start = Date.now();
const seen: number[] = [];
await Promise.all([1, 2, 3].map(async () => { await budget.wait("https://same.test/path?ignored=yes", signal, 1000); seen.push(Date.now() - start); }));
assert.ok(seen[1] >= 90 && seen[2] >= 210, "Parallel conversations share the same origin's navigation spacing");
const independent = Date.now();
await budget.wait("https://other.test/", signal, 1000);
assert.ok(Date.now() - independent < 90, "Unrelated origins do not share navigation slots");
budget.defer("https://same.test/another", Date.now() + 10_000);
await assert.rejects(() => budget.wait("https://same.test/", signal, 1000), /cooldown/);
await budget.wait("https://other.test/", signal, 1000);

const cancelled = new AbortController();
const paced = new BrowserNavigationBudget(500);
await paced.wait("https://cancel.test/", signal, 1000);
const pending = paced.wait("https://cancel.test/", cancelled.signal, 1000);
cancelled.abort();
await assert.rejects(() => pending, /abort/i);
await assert.rejects(() => paced.wait("https://cancel.test/", signal, 1), /busy/);

assert.equal(resolveBrowserExecutable({ executablePathEnv: "", cdpEndpointEnv: "" }), undefined);
assert.equal(resolveBrowserExecutable({ executablePathEnv: "ALIVE_TEST_EXECUTABLE", cdpEndpointEnv: "" }, { ALIVE_TEST_EXECUTABLE: process.execPath }), process.execPath);
assert.throws(() => resolveBrowserExecutable({ executablePathEnv: "ALIVE_TEST_EXECUTABLE", cdpEndpointEnv: "ALIVE_TEST_CDP" }), /not both/);
assert.throws(() => resolveBrowserExecutable({ executablePathEnv: "bad-name", cdpEndpointEnv: "" }), /variable name/);
assert.throws(() => resolveBrowserExecutable({ executablePathEnv: "ALIVE_TEST_EXECUTABLE", cdpEndpointEnv: "" }, { ALIVE_TEST_EXECUTABLE: "secret-relative-path" }), error => error instanceof Error && !error.message.includes("secret-relative-path"));
console.log("browser access policy checks passed");
