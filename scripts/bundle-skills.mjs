import { copyFileSync, mkdirSync } from "node:fs";

// Keep the guide with its runtime generation, including dist.prev rollback.
const target = new URL("../dist/skills/anti-slop/", import.meta.url);
mkdirSync(target, { recursive: true });
copyFileSync(new URL("../skills/anti-slop/SKILL.md", import.meta.url), new URL("SKILL.md", target));
