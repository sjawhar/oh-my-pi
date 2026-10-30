import { describe, expect, test } from "bun:test";
import { HOW_FOUND, SEVERITIES, countBy, loadFalseBeliefs, loadFindings } from "./corpus.ts";

const findings = loadFindings();
const beliefs = loadFalseBeliefs();

describe("corpus findings", () => {
	test("the corpus is not empty and ids are unique", () => {
		expect(findings.length).toBeGreaterThan(100);
		expect(new Set(findings.map(f => f.id)).size).toBe(findings.length);
	});

	test("every record carries the frozen fields with usable values", () => {
		for (const f of findings) {
			expect(HOW_FOUND).toContain(f.how_found_primary);
			expect(SEVERITIES).toContain(f.severity);
			expect(f.pr).toBeGreaterThan(0);
			expect(f.round).toBeGreaterThan(0);
			expect(f.head_sha.length).toBeGreaterThanOrEqual(12);
			expect(f.title.length).toBeGreaterThan(0);
			expect(f.files.length).toBeGreaterThan(0);
			expect(f.trigger.length).toBeGreaterThan(0);
			expect(f.report_path.length).toBeGreaterThan(0);
		}
	});

	test("how_found_primary is the strongest label the record carries", () => {
		for (const f of findings) {
			expect(f.how_found.length).toBeGreaterThan(0);
			for (const label of f.how_found) expect(HOW_FOUND).toContain(label);
			const strongest = f.how_found.reduce((a, b) => (HOW_FOUND.indexOf(b) > HOW_FOUND.indexOf(a) ? b : a));
			expect({ id: f.id, primary: f.how_found_primary }).toEqual({ id: f.id, primary: strongest });
		}
	});

	test("a closed finding names the head that closed it", () => {
		for (const f of findings) {
			if (!f.closed) continue;
			expect(typeof f.closed_at_sha === "string" && f.closed_at_sha.length >= 8).toBe(true);
			expect(f.closed_round === null || f.closed_round > f.round).toBe(true);
		}
	});

	test("an open finding claims no closing head", () => {
		for (const f of findings) {
			if (f.closed) continue;
			expect(f.closed_at_sha).toBeNull();
		}
	});

	test("every label is quoted from the report that justifies it", () => {
		for (const f of findings) expect(f.how_found_quote.length).toBeGreaterThan(10);
	});

	test("the measurement is kept, not summarised away", () => {
		// `measured` is what makes a record gradable. A record without it would
		// let a reviewer score by agreeing with a title.
		const empty = findings.filter(f => f.measured.trim().length === 0);
		expect(empty.map(f => f.id)).toEqual([]);
	});

	test("finding ids are prefixed by their pull request", () => {
		for (const f of findings) expect(f.id.startsWith(`${f.pr}-`)).toBe(true);
	});
});

describe("corpus false beliefs", () => {
	test("each belief quotes the claim and the measurement that broke it", () => {
		expect(beliefs.length).toBeGreaterThan(20);
		for (const b of beliefs) {
			expect(b.lane_claim.length).toBeGreaterThan(10);
			expect(b.falsifying_evidence.length).toBeGreaterThan(5);
			expect(b.falsified_by.length).toBeGreaterThan(0);
			expect(b.lane_report_path.length).toBeGreaterThan(0);
		}
	});

	test("belief ids are unique", () => {
		expect(new Set(beliefs.map(b => b.id)).size).toBe(beliefs.length);
	});
});

describe("the distribution the eval rests on", () => {
	test("almost nothing was found by reading alone", () => {
		const byHow = countBy(findings, f => f.how_found_primary);
		const readOnly = (byHow["read-diff"] ?? 0) + (byHow["read-surrounding"] ?? 0);
		expect(readOnly / findings.length).toBeLessThan(0.1);
	});
});
