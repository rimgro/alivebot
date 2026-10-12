import { createHmac, timingSafeEqual } from "node:crypto";

/** Telegram's Mini App HMAC validation; never log initData or the bot token. */
export function verifyTelegramOperator(raw: unknown, token: string, recipient: string, now = Date.now()): boolean {
	if (typeof raw !== "string" || raw.length > 8192 || !token || !recipient) return false;
	try {
		const fields = new URLSearchParams(raw);
		if ([...fields.keys()].some(key => fields.getAll(key).length !== 1)) return false;
		const hash = fields.get("hash") || "", date = Number(fields.get("auth_date"));
		if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(date) || date > now / 1000 + 30 || now / 1000 - date > 600) return false;
		fields.delete("hash");
		const check = [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("\n");
		const secret = createHmac("sha256", "WebAppData").update(token).digest();
		const expected = createHmac("sha256", secret).update(check).digest();
		if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return false;
		const user = JSON.parse(fields.get("user") || "null");
		return Number.isSafeInteger(user?.id) && !user.is_bot && String(user.id) === recipient;
	} catch { return false; }
}
