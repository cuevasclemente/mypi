import { readFileSync } from "node:fs";
import { EmbeddingClient } from "./embed-client.js";
import { fuseSearchResults, lexicalSearch, type SearchSkill } from "./search.js";

interface Fixture { positive: Array<[string, string]>; negative: string[] }

async function main() {
	const catalogPath = process.argv[2];
	if (!catalogPath) throw new Error("Usage: tsx evaluate-relevance.ts /path/to/catalog.json");
	const catalog = (JSON.parse(readFileSync(catalogPath, "utf8")) as Array<SearchSkill & { disableModelInvocation?: boolean }>)
		.filter((skill) => !skill.disableModelInvocation);
	const fixture = JSON.parse(readFileSync(new URL("./relevance-fixture.json", import.meta.url), "utf8")) as Fixture;
	const embeddings = new EmbeddingClient();
	let lexical1 = 0;
	let lexical3 = 0;
	let hybrid1 = 0;
	let hybrid3 = 0;
	let denseQueries = 0;
	const misses: Array<Record<string, unknown>> = [];
	for (const [query, expected] of fixture.positive) {
		const lexical = lexicalSearch(catalog, query, 20);
		const dense = await embeddings.search(catalog, query, 20);
		if (dense.length > 0) denseQueries++;
		const hybrid = fuseSearchResults(catalog, lexical, dense, query, 5);
		const lexicalIndex = lexical.findIndex((skill) => skill.name === expected);
		const hybridIndex = hybrid.findIndex((skill) => skill.name === expected);
		if (lexicalIndex === 0) lexical1++;
		if (lexicalIndex >= 0 && lexicalIndex < 3) lexical3++;
		if (hybridIndex === 0) hybrid1++;
		if (hybridIndex >= 0 && hybridIndex < 3) hybrid3++;
		if (hybridIndex < 0 || hybridIndex >= 3) misses.push({ query, expected, returned: hybrid.map((skill) => skill.name) });
	}
	let falseMatches = 0;
	for (const query of fixture.negative) {
		const lexical = lexicalSearch(catalog, query, 20);
		const dense = await embeddings.search(catalog, query, 20);
		if (dense.length > 0) denseQueries++;
		const hybrid = fuseSearchResults(catalog, lexical, dense, query, 5);
		if (hybrid.length > 0) {
			falseMatches++;
			misses.push({ query, expected: "no-match", returned: hybrid.map((skill) => skill.name) });
		}
	}
	await embeddings.stop();
	const result = {
		positive: fixture.positive.length,
		negative: fixture.negative.length,
		lexicalRecall1: lexical1 / fixture.positive.length,
		lexicalRecall3: lexical3 / fixture.positive.length,
		hybridRecall1: hybrid1 / fixture.positive.length,
		hybridRecall3: hybrid3 / fixture.positive.length,
		noMatchPrecision: 1 - falseMatches / fixture.negative.length,
		denseResultCoverage: denseQueries / (fixture.positive.length + fixture.negative.length),
		misses,
	};
	console.log(JSON.stringify(result, null, 2));
	if (
		result.lexicalRecall1 < 0.9
		|| result.hybridRecall1 < 0.9
		|| result.hybridRecall3 < 0.9
		|| result.noMatchPrecision < 0.9
		|| result.denseResultCoverage < 1
	) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
