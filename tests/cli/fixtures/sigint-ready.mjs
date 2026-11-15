// Preloaded (node --import) into the built bin by built.test.ts. It prints a
// marker on stderr once the bin has installed its SIGINT handler, so a test
// can send SIGINT only when the handler is there, without sleeping.
const on = process.on;
process.on = function (event, listener) {
	const result = on.call(this, event, listener);
	if (event === "SIGINT") {
		process.stderr.write("<sigint-handler-ready>\n");
	}
	return result;
};
