/**
 * The login interaction types of `@earendil-works/pi-ai` 1.5.2
 * (`dist/auth/types.d.ts`), restated here because the coding agent does not
 * re-export them and pi-ai is not a direct dependency.
 */

export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: readonly { id: string; label: string; description?: string }[];
	  }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
	| {
			type: "info";
			message: string;
			links?: readonly { url: string; label?: string }[];
	  }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			openBrowserOnConfirm?: boolean;
			copyCodeOnConfirm?: boolean;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}
