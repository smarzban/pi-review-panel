/**
 * Runs one action from an argument object through the production dispatch
 * the CLI uses (`coerceCallArguments`, then `callAction`), with injected
 * dependencies, so a test can drive the core actions without a model, a key
 * or GitHub. The CLI's own `call` path is tested in tests/cli/run.test.ts.
 */
import type {
	ActionDependencies,
	ActionResult,
} from "../../src/actions/actions.js";
import { callAction, coerceCallArguments } from "../../src/actions/call.js";
import type { ReviewProgressView } from "../../src/tool/review-presentation.js";

export type PanelCaller = {
	execute(
		callId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onProgress?: (view: ReviewProgressView) => void,
		options?: { cwd?: string },
	): Promise<ActionResult>;
};

export function createPanelCaller(deps?: ActionDependencies): PanelCaller {
	return {
		execute(_callId, args, signal, onProgress, options) {
			return callAction(coerceCallArguments(args), {
				cwd: options?.cwd ?? process.cwd(),
				context: {
					...(deps === undefined ? {} : { deps }),
					...(signal === undefined ? {} : { signal }),
					...(onProgress === undefined ? {} : { onProgress }),
					startedAt: Date.now(),
				},
			});
		},
	};
}
