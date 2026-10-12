const OWNER_PID = Symbol.for("alive.microsandbox.ownerPid");

/** Capture the host supervisor PID once, then remove it from the guest env. */
export function initializeSandboxRuntimeIdentity(): void {
	const pid = Number(process.env.ALIVE_RUNTIME_PID);
	delete process.env.ALIVE_RUNTIME_PID;
	if (Number.isInteger(pid) && pid > 0) (globalThis as Record<symbol, unknown>)[OWNER_PID] = pid;
}

export function sandboxRuntimeOwnerPid(): number | undefined {
	const pid = (globalThis as Record<symbol, unknown>)[OWNER_PID];
	return typeof pid === "number" ? pid : undefined;
}
