export interface SearchSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	scope?: string;
}

export interface RankedSkill extends SearchSkill {
	score: number;
	lexicalRank?: number;
	denseRank?: number;
}

export interface DenseResult {
	name: string;
	score: number;
}

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const RRF_K = 60;
export const MIN_LEXICAL_SCORE = 5;
export const MIN_DENSE_SCORE = 0.63;

export function tokenize(text: string): string[] {
	return (text.toLocaleLowerCase().replaceAll("-", " ").match(WORD_PATTERN) ?? [])
		.filter((term) => term.length > 1 || /^\d$/.test(term));
}

function termCounts(tokens: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

export function lexicalSearch(skills: SearchSkill[], query: string, limit = 20): RankedSkill[] {
	if (skills.length === 0 || limit <= 0) return [];
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0) return [];

	const documents = skills.map((skill) => {
		const tokens = tokenize(`${skill.name.replaceAll("-", " ")} ${skill.description}`);
		return { skill, tokens, counts: termCounts(tokens) };
	});
	const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length || 1;
	const documentFrequency = new Map<string, number>();
	for (const term of queryTokens) {
		documentFrequency.set(term, documents.reduce((count, document) => count + (document.counts.has(term) ? 1 : 0), 0));
	}
	const normalizedQuery = query.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

	return documents
		.map(({ skill, tokens, counts }) => {
			let score = 0;
			for (const term of queryTokens) {
				const frequency = counts.get(term) ?? 0;
				if (frequency === 0) continue;
				const df = documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
				const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * tokens.length / averageLength);
				score += idf * (frequency * (BM25_K1 + 1)) / denominator;
			}
			const normalizedName = skill.name.toLocaleLowerCase();
			if (normalizedQuery === normalizedName) score += 20;
			if (normalizedQuery && normalizedName.includes(normalizedQuery)) score += 5;
			const nameTerms = new Set(tokenize(skill.name));
			score += queryTokens.reduce((sum, term) => sum + (nameTerms.has(term) ? 1.25 : 0), 0);
			return { ...skill, score };
		})
		.filter((result) => result.score > 0)
		.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
		.slice(0, Math.min(limit, skills.length));
}

export function fuseSearchResults(
	skills: SearchSkill[],
	lexical: RankedSkill[],
	dense: DenseResult[],
	query: string,
	limit: number,
): RankedSkill[] {
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	const scores = new Map<string, RankedSkill>();
	const add = (name: string, rank: number, kind: "lexical" | "dense") => {
		const skill = byName.get(name);
		if (!skill) return;
		const existing = scores.get(name) ?? { ...skill, score: 0 };
		const weight = kind === "dense" ? 0.4 : 0.6;
		existing.score += weight / (RRF_K + rank + 1);
		if (kind === "dense") existing.denseRank = rank + 1;
		else existing.lexicalRank = rank + 1;
		scores.set(name, existing);
	};
	lexical
		.filter((result) => result.score >= MIN_LEXICAL_SCORE)
		.forEach((result, index) => add(result.name, index, "lexical"));
	dense
		.filter((result) => result.score >= MIN_DENSE_SCORE)
		.forEach((result, index) => add(result.name, index, "dense"));

	const exact = query.trim().toLocaleLowerCase();
	const exactSkill = skills.find((skill) => skill.name.toLocaleLowerCase() === exact);
	if (exactSkill) {
		const result = scores.get(exactSkill.name) ?? { ...exactSkill, score: 0 };
		result.score += 1;
		scores.set(exactSkill.name, result);
	}

	return [...scores.values()]
		.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
		.slice(0, Math.max(1, Math.min(limit, 8)));
}
