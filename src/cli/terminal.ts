/** The process terminal: prompts on stderr, answers from stdin. */
import { createInterface } from "node:readline/promises";
import { addAbortSignal, type Readable, Writable } from "node:stream";

import type { AuthTerminal } from "./auth.js";

/**
 * All of a stream, unless the signal aborts first. On abort the stream is
 * destroyed, so an open stdin pipe cannot keep the process alive.
 */
export async function readAll(
	stream: Readable,
	signal: AbortSignal,
): Promise<string> {
	const chunks: Buffer[] = [];
	try {
		for await (const chunk of addAbortSignal(signal, stream)) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		}
	} catch (error) {
		throw signal.aborted ? signal.reason : error;
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The streams a terminal reads and writes; the process's own by default. */
export type TerminalStreams = {
	input: Readable & { isTTY?: boolean };
	output: NodeJS.WritableStream;
};

const PROCESS_STREAMS = (): TerminalStreams => ({
	input: process.stdin,
	output: process.stderr,
});

async function ask(
	streams: TerminalStreams,
	message: string,
	signal: AbortSignal,
	hidden: boolean,
): Promise<string> {
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) {
				streams.output.write(chunk);
			}
			callback();
		},
	});
	const rl = createInterface({
		input: streams.input,
		output,
		terminal: streams.input.isTTY === true,
	});
	// On a terminal, readline takes Ctrl-C as a key and would only pause.
	// Hand it to the process handler, which aborts the login.
	rl.on("SIGINT", () => {
		process.emit("SIGINT");
	});
	try {
		if (hidden) {
			streams.output.write(message);
			muted = true;
			const answer = await rl.question("", { signal });
			streams.output.write("\n");
			return answer;
		}
		return await rl.question(message, { signal });
	} finally {
		rl.close();
	}
}

export function processTerminal(
	streams: TerminalStreams = PROCESS_STREAMS(),
): AuthTerminal {
	return {
		interactive: streams.input.isTTY === true,
		write: (line) => {
			streams.output.write(`${line}\n`);
		},
		question: (message, signal) => ask(streams, message, signal, false),
		secret: (message, signal) => ask(streams, message, signal, true),
		readStdin: (signal) => readAll(streams.input, signal),
	};
}
