/**
 * The real process terminal, driven through a stream that says it is a TTY,
 * the way a terminal's stdin does. readline then reads keys in raw mode and
 * echoes them itself, which is exactly what the hidden prompt must suppress.
 */
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { processTerminal, readAll } from "../src/terminal.js";

function fakeTty() {
	const input = Object.assign(new PassThrough(), {
		isTTY: true,
		setRawMode: () => input,
	});
	let written = "";
	const output = new Writable({
		write(chunk, _encoding, callback) {
			written += String(chunk);
			callback();
		},
	});
	return { input, output, written: () => written };
}

async function until(check: () => boolean): Promise<void> {
	while (!check()) {
		await new Promise((resolve) => setImmediate(resolve));
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
		await until(() => tty.written().includes("Enter Anthropic API key: "));
		tty.input.write("sk-TYPED-KEY-42\r");
		expect(await answer).toBe("sk-TYPED-KEY-42");
		expect(tty.written()).toBe("Enter Anthropic API key: \n");
	});

	it("question: echoes what is typed, as a visible prompt should", async () => {
		const tty = fakeTty();
		const answer = processTerminal(tty).question(
			"Select 1-2: ",
			new AbortController().signal,
		);
		await until(() => tty.written().includes("Select 1-2: "));
		tty.input.write("2\r");
		expect(await answer).toBe("2");
		expect(tty.written()).toContain("2");
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
