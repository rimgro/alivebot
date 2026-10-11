declare module "tilion-fortress" {
	import type { ChildProcess } from "node:child_process";
	export class Fortress {
		constructor(options?: { port?: number; headless?: boolean; persona?: { platform?: string }; extraArgs?: string[] });
		proc: ChildProcess | null;
		start(): Promise<this>;
		close(): Promise<void>;
	}
}
