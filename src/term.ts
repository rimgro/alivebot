const enabled = process.stderr.isTTY && process.env.NO_COLOR === undefined;

function wrap(code: number, close: number) {
	return (value: string): string => (enabled ? `\x1b[${code}m${value}\x1b[${close}m` : value);
}

export const term = {
	dim: wrap(2, 22),
	bold: wrap(1, 22),
	italic: wrap(3, 23),
	red: wrap(31, 39),
	green: wrap(32, 39),
	yellow: wrap(33, 39),
	blue: wrap(34, 39),
	magenta: wrap(35, 39),
	cyan: wrap(36, 39),
	gray: wrap(90, 39),
};

export function stamp(): string {
	return new Date().toISOString().slice(11, 19);
}
