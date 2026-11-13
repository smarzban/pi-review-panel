/** The process terminal: prompts on stderr, answers from stdin. */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import type { AuthTerminal } from "./auth.js";

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function ask(
	message: string,
	signal: AbortSignal,
	hidden: boolean,
): Promise<string> {
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) {
				process.stderr.write(chunk);
			}
			callback();
		},
	});
	const rl = createInterface({
		input: process.stdin,
		output,
		terminal: process.stdin.isTTY === true,
	});
	// On a terminal, readline takes Ctrl-C as a key and would only pause.
	// Hand it to the process handler, which aborts the login.
	rl.on("SIGINT", () => {
		process.emit("SIGINT");
	});
	try {
		if (hidden) {
			process.stderr.write(message);
			muted = true;
			const answer = await rl.question("", { signal });
			process.stderr.write("\n");
			return answer;
		}
		return await rl.question(message, { signal });
	} finally {
		rl.close();
	}
}

export function processTerminal(): AuthTerminal {
	return {
		interactive: process.stdin.isTTY === true,
		write: (line) => {
			process.stderr.write(`${line}\n`);
		},
		question: (message, signal) => ask(message, signal, false),
		secret: (message, signal) => ask(message, signal, true),
		readStdin: () => readAll(process.stdin),
	};
}
