/**
 * Runs one action from an argument object the way `review-panel call` does
 * (the lenient coercions, the repository from `repository` or the working
 * folder, each action's own validation), with injected dependencies, so a test
 * can drive the core actions without a model, a key or GitHub.
 */
import type {
	ActionDependencies,
	ActionResult,
} from "../../src/actions/actions.js";
import {
	ACTION_PARSERS,
	coerceCallArguments,
	isActionName,
	realActions,
} from "../../src/actions/call.js";
import { resolveReviewRepository } from "../../src/actions/repository.js";
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
		async execute(_callId, rawArgs, signal, onProgress, options) {
			const args = coerceCallArguments(rawArgs);
			if (!isActionName(args.action)) {
				throw new Error(`no such action: ${String(args.action)}`);
			}
			const repoDir = resolveReviewRepository(
				args.repository,
				options?.cwd ?? process.cwd(),
			);
			const input = ACTION_PARSERS[args.action](args);
			const run = realActions[args.action] as (
				input: Record<string, unknown>,
				context: object,
			) => Promise<ActionResult>;
			return run(
				{ repoDir, ...input },
				{
					...(deps === undefined ? {} : { deps }),
					...(signal === undefined ? {} : { signal }),
					...(onProgress === undefined ? {} : { onProgress }),
					startedAt: Date.now(),
				},
			);
		},
	};
}
