// JSON + Markdown Reporting

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Question, RunReport, ScoredResult } from './types.ts';

interface PerQuestion {
    question: Question;
    results: ScoredResult[];
}

function avg(nums: number[]): number {
    return nums.length === 0 ? 0 : Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function tally(results: ScoredResult[]) {
    const t = { PASS: 0, PARTIAL: 0, FAIL: 0, avgLatencyMs: 0 };
    for (const r of results) t[r.verdict] += 1;
    t.avgLatencyMs = avg(results.map((r) => r.latencyMs));
    return t;
}

export function buildReport(runId: string, startedAt: string, finishedAt: string, perQuestion: PerQuestion[]): RunReport {
    const flat = perQuestion.flatMap((p) => p.results);
    const aResults = flat.filter((r) => r.variant === 'A');
    const bNaive = flat.filter((r) => r.variant === 'B-naive');
    const bBoostedAnswer = flat.filter((r) => r.variant === 'B-boosted' && r.scoreType === 'answer');
    const bBoostedRetrieval = flat.filter((r) => r.variant === 'B-boosted' && r.scoreType === 'retrieval');

    return {
        runId,
        startedAt,
        finishedAt,
        questions: perQuestion.map((p) => ({
            id: p.question.id,
            category: p.question.category,
            question: p.question.question,
            groundTruth: p.question.ground_truth,
            results: p.results,
        })),
        summary: {
            totalQuestions: perQuestion.length,
            perCondition: {
                A: tally(aResults),
                'B-naive': tally(bNaive),
                'B-boosted-answer': tally(bBoostedAnswer),
                'B-boosted-retrieval': tally(bBoostedRetrieval),
            },
        },
    };
}

export async function writeReports(outDir: string, runId: string, report: RunReport): Promise<{ jsonPath: string; mdPath: string }> {
    await mkdir(outDir, { recursive: true });
    const jsonPath = join(outDir, `run-${runId}.json`);
    const mdPath = join(outDir, `run-${runId}.md`);
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    await writeFile(mdPath, renderMarkdown(report), 'utf8');
    return { jsonPath, mdPath };
}

function fmtVerdict(verdict: string | undefined): string {
    if (!verdict) return '–';
    return verdict;
}

function fmtLatency(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function renderMarkdown(report: RunReport): string {
    const s = report.summary.perCondition;
    const lines: string[] = [];
    lines.push(`# Eval Run ${report.runId}`);
    lines.push('');
    lines.push(`Start: ${report.startedAt}  Ende: ${report.finishedAt}  Fragen: ${report.summary.totalQuestions}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Bedingung | PASS | PARTIAL | FAIL | Avg Latency |');
    lines.push('|---|---|---|---|---|');
    lines.push(`| A (Data Library, Antwort) | ${s.A.PASS} | ${s.A.PARTIAL} | ${s.A.FAIL} | ${fmtLatency(s.A.avgLatencyMs)} |`);
    lines.push(`| B-naive (Retrieval) | ${s['B-naive'].PASS} | ${s['B-naive'].PARTIAL} | ${s['B-naive'].FAIL} | ${fmtLatency(s['B-naive'].avgLatencyMs)} |`);
    lines.push(`| B-boosted (Antwort) | ${s['B-boosted-answer'].PASS} | ${s['B-boosted-answer'].PARTIAL} | ${s['B-boosted-answer'].FAIL} | ${fmtLatency(s['B-boosted-answer'].avgLatencyMs)} |`);
    lines.push(`| B-boosted (Retrieval) | ${s['B-boosted-retrieval'].PASS} | ${s['B-boosted-retrieval'].PARTIAL} | ${s['B-boosted-retrieval'].FAIL} | ${fmtLatency(s['B-boosted-retrieval'].avgLatencyMs)} |`);
    lines.push('');
    lines.push('## Per-Question Breakdown');
    lines.push('');
    lines.push('| ID | Kategorie | A (Antwort) | B-naive (Retrieval) | B-boosted (Antwort) | B-boosted (Retrieval) | Bemerkung |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const q of report.questions) {
        const a = q.results.find((r) => r.variant === 'A');
        const bn = q.results.find((r) => r.variant === 'B-naive');
        const bb_a = q.results.find((r) => r.variant === 'B-boosted' && r.scoreType === 'answer');
        const bb_r = q.results.find((r) => r.variant === 'B-boosted' && r.scoreType === 'retrieval');
        const note = bb_a?.diagnosticInfo ?? bb_r?.diagnosticInfo ?? '';
        lines.push(
            `| ${q.id} | ${q.category} | ${fmtVerdict(a?.verdict)} | ${fmtVerdict(bn?.verdict)} | ${fmtVerdict(bb_a?.verdict)} | ${fmtVerdict(bb_r?.verdict)} | ${note.slice(0, 80).replace(/\|/g, '\\|')} |`,
        );
    }
    lines.push('');
    lines.push('## Demo-relevante Highlights');
    lines.push('');
    lines.push(buildHighlights(report));
    lines.push('');
    return lines.join('\n');
}

function buildHighlights(report: RunReport): string {
    const lines: string[] = [];
    const aFailBBoostedPass = report.questions.filter((q) => {
        const a = q.results.find((r) => r.variant === 'A');
        const bb = q.results.find((r) => r.variant === 'B-boosted' && r.scoreType === 'answer');
        return a?.verdict === 'FAIL' && bb?.verdict === 'PASS';
    });
    const naiveFailBoostedPass = report.questions.filter((q) => {
        const bn = q.results.find((r) => r.variant === 'B-naive');
        const bbr = q.results.find((r) => r.variant === 'B-boosted' && r.scoreType === 'retrieval');
        return bn?.verdict === 'FAIL' && bbr?.verdict === 'PASS';
    });
    const allPass = report.questions.filter((q) => q.results.every((r) => r.verdict === 'PASS'));

    lines.push(`- Stärkste Differenz A vs. B-boosted (A=FAIL, B=PASS): ${aFailBBoostedPass.map((q) => q.id).join(', ') || '–'}`);
    lines.push(`- Stärkste Differenz B-naive vs. B-boosted (Retrieval, naive=FAIL, boosted=PASS): ${naiveFailBoostedPass.map((q) => q.id).join(', ') || '–'}`);
    lines.push(`- Parität (alle Bedingungen PASS): ${allPass.map((q) => q.id).join(', ') || '–'}`);
    return lines.join('\n');
}
