// Scoring: rule-based zuerst, LLM-Judge nur bei PARTIAL.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Chunk, ConditionResult, Question, ScoredResult, Verdict } from './types.ts';

const JUDGE_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Normalisierung + Token-Match
// ---------------------------------------------------------------------------

function normalize(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9äöüß\s%°]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(s: string): string[] {
    return normalize(s)
        .split(' ')
        .filter((t) => t.length > 1);
}

function tokenMatchRatio(answer: string, gt: string): { matched: number; total: number; ratio: number } {
    const a = normalize(answer);
    const tokens = tokenize(gt);
    if (tokens.length === 0) {
        return { matched: 0, total: 0, ratio: 0 };
    }
    const matched = tokens.filter((t) => a.includes(t)).length;
    return { matched, total: tokens.length, ratio: matched / tokens.length };
}

// ---------------------------------------------------------------------------
// Rule-based Answer-Scoring
// ---------------------------------------------------------------------------

interface Verdicted {
    verdict: Verdict;
    rationale: string;
}

export function scoreAnswerRuleBased(answer: string | undefined, gt: string): Verdicted {
    if (!answer || !answer.trim()) {
        return { verdict: 'FAIL', rationale: 'Leere Antwort' };
    }
    const { matched, total, ratio } = tokenMatchRatio(answer, gt);
    if (ratio >= 0.85) return { verdict: 'PASS', rationale: `${matched}/${total} GT-Tokens enthalten` };
    if (ratio >= 0.5) return { verdict: 'PARTIAL', rationale: `${matched}/${total} GT-Tokens, LLM-Judge zur Klärung` };
    return { verdict: 'FAIL', rationale: `${matched}/${total} GT-Tokens fehlen` };
}

// ---------------------------------------------------------------------------
// Rule-based Retrieval-Scoring
// ---------------------------------------------------------------------------

export function scoreRetrievalRuleBased(
    chunks: Chunk[] | undefined,
    gt: string,
    expectedSource: string,
): Verdicted {
    if (!chunks || chunks.length === 0) {
        return { verdict: 'FAIL', rationale: 'Keine Treffer' };
    }
    const expectedSources = expectedSource.split(',').map((s) => s.trim().toLowerCase());
    const gtTokens = tokenize(gt);
    const requiredHits = Math.max(1, Math.ceil(gtTokens.length * 0.5));

    let bestContentMatch = 0;
    let sourceMatchFound = false;
    for (const chunk of chunks) {
        const content = normalize(chunk.content);
        const hits = gtTokens.filter((t) => content.includes(t)).length;
        bestContentMatch = Math.max(bestContentMatch, hits);

        const chunkSource = chunk.sourceFile.toLowerCase();
        if (expectedSources.some((s) => s && chunkSource.includes(s))) {
            sourceMatchFound = true;
        }
    }

    const contentHit = bestContentMatch >= requiredHits;
    if (contentHit && sourceMatchFound) {
        return { verdict: 'PASS', rationale: `Top-Chunk enthält ${bestContentMatch}/${gtTokens.length} GT-Tokens und stammt aus ${expectedSource}` };
    }
    if (contentHit) {
        return { verdict: 'PARTIAL', rationale: `GT inhaltlich getroffen, aber nicht aus ${expectedSource}` };
    }
    if (sourceMatchFound) {
        return { verdict: 'PARTIAL', rationale: `Quelle ${expectedSource} im Top-K, aber GT-Tokens kaum getroffen (${bestContentMatch}/${gtTokens.length})` };
    }
    return { verdict: 'FAIL', rationale: `Weder GT-Tokens noch erwartete Quelle im Top-K (${bestContentMatch}/${gtTokens.length})` };
}

// ---------------------------------------------------------------------------
// LLM-Judge mit Cache
// ---------------------------------------------------------------------------

interface JudgeCacheEntry {
    verdict: Verdict;
    rationale: string;
}

let cache: Record<string, JudgeCacheEntry> | null = null;
let cachePath: string | null = null;

export async function loadJudgeCache(path: string): Promise<void> {
    cachePath = path;
    if (existsSync(path)) {
        try {
            const raw = await readFile(path, 'utf8');
            cache = JSON.parse(raw);
        } catch {
            cache = {};
        }
    } else {
        cache = {};
    }
}

export async function saveJudgeCache(): Promise<void> {
    if (cachePath && cache) {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    }
}

function judgeKey(questionId: string, condition: string, answer: string): string {
    const hash = createHash('sha256').update(answer).digest('hex').slice(0, 16);
    return `${questionId}::${condition}::${hash}`;
}

export async function judgeWithLlm(
    apiKey: string,
    question: Question,
    answer: string,
    condition: string,
): Promise<Verdicted> {
    const key = judgeKey(question.id, condition, answer);
    if (cache && cache[key]) {
        return { ...cache[key], rationale: cache[key].rationale + ' (cached)' };
    }

    const client = new Anthropic({ apiKey });
    const prompt =
        `Du bewertest die Antwort eines KI-Agents gegen eine Soll-Antwort.\n\n` +
        `Frage: ${question.question}\n` +
        `Soll-Antwort (Ground Truth): ${question.ground_truth}\n` +
        `Tatsächliche Antwort: ${answer}\n\n` +
        `Bewerte mit genau einem der folgenden Werte:\n` +
        `- PASS: Die Antwort enthält die Ground Truth in einer akzeptablen Formulierung.\n` +
        `- PARTIAL: Die Antwort enthält Teile der Ground Truth oder ist mehrdeutig.\n` +
        `- FAIL: Die Antwort enthält die Ground Truth nicht oder ist falsch.\n\n` +
        `Antworte ausschließlich als JSON: {"verdict": "PASS|PARTIAL|FAIL", "rationale": "<ein Satz>"}`;

    const resp = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 256,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim();

    let parsed: Verdicted;
    try {
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        const json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        const verdict = json.verdict as Verdict;
        if (verdict !== 'PASS' && verdict !== 'PARTIAL' && verdict !== 'FAIL') {
            throw new Error(`Unerwartetes Verdict: ${verdict}`);
        }
        parsed = { verdict, rationale: String(json.rationale ?? '').slice(0, 500) };
    } catch (e) {
        parsed = { verdict: 'FAIL', rationale: `Judge-Parse-Fehler: ${(e as Error).message}` };
    }

    if (cache) cache[key] = parsed;
    return parsed;
}

// ---------------------------------------------------------------------------
// Hauptfunktion: Score eine ConditionResult
// ---------------------------------------------------------------------------

export interface ScoringOptions {
    skipJudge: boolean;
    apiKey: string;
}

export async function scoreResult(
    cr: ConditionResult,
    question: Question,
    opts: ScoringOptions,
): Promise<ScoredResult[]> {
    const out: ScoredResult[] = [];
    if (cr.error) {
        out.push({
            ...cr,
            verdict: 'FAIL',
            rationale: `Fehler: ${cr.error}`,
            scoreType: cr.variant === 'B-naive' ? 'retrieval' : 'answer',
            judgeUsed: false,
        });
        return out;
    }

    // Variante A und B-boosted: Antwort scoren
    if (cr.variant === 'A' || cr.variant === 'B-boosted') {
        let v = scoreAnswerRuleBased(cr.answer, question.ground_truth);
        let judgeUsed = false;
        if (v.verdict === 'PARTIAL' && !opts.skipJudge && cr.answer) {
            v = await judgeWithLlm(opts.apiKey, question, cr.answer, cr.variant);
            judgeUsed = true;
        }
        out.push({ ...cr, verdict: v.verdict, rationale: v.rationale, scoreType: 'answer', judgeUsed });
    }

    // B-naive und B-boosted: Retrieval scoren
    if (cr.variant === 'B-naive' || cr.variant === 'B-boosted') {
        const v = scoreRetrievalRuleBased(cr.retrievedChunks, question.ground_truth, question.expected_source);
        out.push({ ...cr, verdict: v.verdict, rationale: v.rationale, scoreType: 'retrieval', judgeUsed: false });
    }

    return out;
}
