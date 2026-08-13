export type AddedLine = {
	file: string;
	line: number;
	text: string;
};

export type Changeset = {
	files: string[];
	addedLines: AddedLine[];
};

export type Suggestion = {
	lens: string;
	reason: string;
	evidence: Array<{ file: string; line?: number }>;
};

type Rule = (changeset: Changeset) => Suggestion | null;

const MIGRATION_DIR_RE = /(^|\/)migrations?\//i;
const MIGRATE_DIR_RE = /(^|\/)migrate\//i;
const SQL_FILE_RE = /\.sql$/i;

const SECURITY_RE = new RegExp(
	[
		"child_process",
		"\\.execSync?\\b",
		"\\.spawn(Sync)?\\b",
		"subprocess\\.",
		"os\\.system\\b",
		"Runtime\\.getRuntime\\(\\)\\.exec",
		"\\bpopen\\b",
		"crypto\\.",
		"createCipher",
		"createHash",
		"createHmac",
		"randomBytes",
		"pbkdf2",
		"\\bbcrypt\\b",
		"\\bscrypt\\b",
		"createSign",
		"\\bjwt\\b",
		"jsonwebtoken",
		"\\boauth\\b",
		"authenticat",
		"authoriz",
		"\\bpassport\\b",
		"password",
		"pickle\\.loads",
		"yaml\\.load\\b",
		"unserialize",
		"Marshal\\.load",
		"ObjectInputStream",
		"readObject",
	].join("|"),
	"i",
);

const SOURCE_FILE_RE =
	/\.([cm]?[jt]sx?|py|go|rb|java|rs|php|cs|kt|swift|scala|c|cc|cpp|h|hpp)$/i;

const TEST_FILE_RE =
	/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/|(^|\/)tests?\/|_test\.go$|(^|\/)test_[^/]+\.py$|_test\.rs$/i;

const CI_WORKFLOW_RE = /(^|\/)\.github\/workflows\//;
const TERRAFORM_RE = /\.tf(vars)?$/i;
const DOCKERFILE_RE = /(^|\/)Dockerfile$|\.Dockerfile$|(^|\/)Dockerfile\./;
const COMPOSE_RE = /docker-compose[^/]*\.ya?ml$/i;

const CONTRACT_RE =
	/(^|\/)(openapi|swagger)\.ya?ml$|\.proto$|\.graphql$|(^|\/)openapi\//i;
const PRIVACY_RE = /(privacy|gdpr|pii)(\.|\/|-)/i;
const SPEC_RE = /(^|\/)docs\/specs\/|(^|\/)acceptance-criteria/i;

function isMigrationPath(file: string): boolean {
	return (
		MIGRATION_DIR_RE.test(file) ||
		MIGRATE_DIR_RE.test(file) ||
		SQL_FILE_RE.test(file)
	);
}

function isTestFile(file: string): boolean {
	return TEST_FILE_RE.test(file);
}

const migrationRule: Rule = (changeset) => {
	const matches = changeset.files.filter(isMigrationPath);
	if (matches.length === 0) {
		return null;
	}
	return {
		lens: "migrations",
		reason: "changed file(s) match a migration/DDL path or extension",
		evidence: matches.map((file) => ({ file })),
	};
};

const securityRule: Rule = (changeset) => {
	const matches = changeset.addedLines.filter((added) =>
		SECURITY_RE.test(added.text),
	);
	if (matches.length === 0) {
		return null;
	}
	return {
		lens: "security",
		reason: "added line(s) touch auth/crypto/subprocess/deserialization",
		evidence: matches.map((added) => ({
			file: added.file,
			line: added.line,
		})),
	};
};

const testsRule: Rule = (changeset) => {
	const testAddedLines = changeset.addedLines.filter((added) =>
		isTestFile(added.file),
	);
	const nonTestSource = changeset.files.filter(
		(file) => !isTestFile(file) && SOURCE_FILE_RE.test(file),
	);
	if (nonTestSource.length === 0 || testAddedLines.length > 0) {
		return null;
	}
	return {
		lens: "tests",
		reason: "source changed with no added lines in recognized test files",
		evidence: nonTestSource.map((file) => ({ file })),
	};
};

const infrastructureRule: Rule = (changeset) => {
	const matches = changeset.files.filter(
		(file) =>
			CI_WORKFLOW_RE.test(file) ||
			TERRAFORM_RE.test(file) ||
			DOCKERFILE_RE.test(file) ||
			COMPOSE_RE.test(file),
	);
	if (matches.length === 0) {
		return null;
	}
	return {
		lens: "infrastructure",
		reason: "IaC / CI-workflow / Dockerfile changed",
		evidence: matches.map((file) => ({ file })),
	};
};

const contractsRule: Rule = (changeset) => {
	const matches = changeset.files.filter((file) => CONTRACT_RE.test(file));
	if (matches.length === 0) {
		return null;
	}
	return {
		lens: "contracts",
		reason: "public schema or API contract file changed",
		evidence: matches.map((file) => ({ file })),
	};
};

const privacyRule: Rule = (changeset) => {
	const matches = changeset.files.filter((file) => PRIVACY_RE.test(file));
	if (matches.length === 0) {
		return null;
	}
	return {
		lens: "privacy",
		reason: "privacy/PII-named path changed",
		evidence: matches.map((file) => ({ file })),
	};
};

const specificationRule: Rule = (changeset) => {
	const matches = changeset.files.filter((file) => SPEC_RE.test(file));
	if (matches.length === 0) {
		return null;
	}
	return {
		lens: "specification-conformance",
		reason: "specification or acceptance-criteria path changed",
		evidence: matches.map((file) => ({ file })),
	};
};

const RULES: Rule[] = [
	migrationRule,
	securityRule,
	testsRule,
	infrastructureRule,
	contractsRule,
	privacyRule,
	specificationRule,
];

/** Advisory lens candidates. Pure: no I/O. Never emits performance. */
export function computeSuggestions(changeset: Changeset): Suggestion[] {
	const suggestions: Suggestion[] = [];
	for (const rule of RULES) {
		const suggestion = rule(changeset);
		if (suggestion !== null) {
			suggestions.push(suggestion);
		}
	}
	return suggestions;
}
