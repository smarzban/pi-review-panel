/**
 * The real process terminal, driven through a stream that says it is a TTY,
 * the way a terminal's stdin does. readline then reads keys in raw mode and
 * echoes them itself, which is exactly what the hidden prompt must suppress.
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processTerminal, readAll } from "../src/terminal.js";

function fakeTty() {
	const input = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode: () => input,
	});
	let written = "";
	const writes = new EventEmitter();
	const output = new Writable({
		write(chunk, _encoding, callback) {
			written += String(chunk);
			writes.emit("write");
			callback();
		},
	});
	return {
		input,
		output,
		written: () => written,
		/** Resolves once the output holds `text`; fails after a short bound. */
		shows: (text: string) => settles(waitForText(text), `output "${text}"`),
	};
	function waitForText(text: string): Promise<void> {
		return new Promise((resolve) => {
			const check = () => {
				if (written.includes(text)) {
					writes.off("write", check);
					resolve();
				}
			};
			writes.on("write", check);
			check();
		});
	}
}

/** `promise`, or a clear failure if it has not settled within a second. */
async function settles<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`timed out after 1s waiting for ${what}`)),
			1_000,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

describe("processTerminal on a TTY", () => {
	it("is interactive", () => {
		const tty = fakeTty();
		expect(processTerminal(tty).interactive).toBe(true);
	});

	it("secret: shows the prompt, returns the typed key, and never echoes it", async () => {
		const tty = fakeTty();
		const answer = processTerminal(tty).secret(
			"Enter Anthropic API key: ",
			new AbortController().signal,
		);
		await tty.shows("Enter Anthropic API key: ");
		tty.input.write("sk-TYPED-KEY-42\r");
		expect(await settles(answer, "the typed key")).toBe("sk-TYPED-KEY-42");
		expect(tty.written()).toBe("Enter Anthropic API key: \n");
	});

	it("question: echoes what is typed, as a visible prompt should", async () => {
		const tty = fakeTty();
		const answer = processTerminal(tty).question(
			"Paste the code: ",
			new AbortController().signal,
		);
		await tty.shows("Paste the code: ");
		// Nothing typed here appears in the prompt, so only the echo can show it.
		tty.input.write("xyzzy\r");
		expect(await settles(answer, "the typed answer")).toBe("xyzzy");
		expect(tty.written()).toContain("xyzzy");
	});

	it("Ctrl-C at a prompt reaches the process SIGINT handler, which aborts the prompt", async () => {
		// Only this test's handler may run: vitest's own must not see the signal.
		const saved = process.listeners("SIGINT");
		process.removeAllListeners("SIGINT");
		const controller = new AbortController();
		let interrupts = 0;
		const onInterrupt = () => {
			interrupts++;
			controller.abort(new Error("interrupted"));
		};
		process.on("SIGINT", onInterrupt);
		try {
			const tty = fakeTty();
			const answer = processTerminal(tty).secret(
				"Enter Anthropic API key: ",
				controller.signal,
			);
			await tty.shows("Enter Anthropic API key: ");
			tty.input.write("sk-PARTIAL\x03");
			await expect(
				settles(answer, "Ctrl-C to abort the prompt"),
			).rejects.toThrow(/aborted|interrupted/);
			expect(interrupts).toBe(1);
			expect(tty.written()).not.toContain("sk-PARTIAL");
		} finally {
			process.off("SIGINT", onInterrupt);
			for (const listener of saved) {
				process.on("SIGINT", listener);
			}
		}
	});
});

describe("readAll", () => {
	it("reads a stream to its end", async () => {
		const input = new PassThrough();
		input.end("a\nb");
		expect(await readAll(input, new AbortController().signal)).toBe("a\nb");
	});

	it("rejects with the abort reason while the stream stays open, and destroys it", async () => {
		const input = new PassThrough();
		const controller = new AbortController();
		const read = readAll(input, controller.signal);
		input.write("partial");
		controller.abort(new Error("interrupted"));
		await expect(read).rejects.toThrow("interrupted");
		expect(input.destroyed).toBe(true);
	});

	it("rejects at once when the signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("interrupted"));
		await expect(readAll(new PassThrough(), controller.signal)).rejects.toThrow(
			"interrupted",
		);
	});
});
