// Eval-Harness Entrypoint.
//
// Aufruf:
//   node scripts/eval/run-eval.ts                       # alle 15 Fragen, mit LLM-Judge
//   node scripts/eval/run-eval.ts --skip-judge          # ohne LLM-Judge (Smoke)
//   node scripts/eval/run-eval.ts --only Q01,Q05        # Stichprobe
//   node scripts/eval/run-eval.ts --questions <path>    # alternative Eval-Datei
//   node scripts/eval/run-eval.ts --out-dir <path>      # alternatives Output-Verzeichnis

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { readEnv } from './auth.ts';
import { runVariantA, runVariantBBoosted, runVariantBNaive } from './conditions.ts';
import { buildReport, writeReports } from './reporters.ts';
import { loadJudgeCache, saveJudgeCache, scoreResult, type ScoringOptions } from './scoring.ts';
import type { Question, ScoredResult } from './types.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

interface CliArgs {
    questionsPath: string;
    outDir: string;
    only: string[] | null;
    skipJudge: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        questionsPath: resolve(REPO_ROOT, 'eval/questions.yaml'),
        outDir: resolve(REPO_ROOT, 'eval/results'),
        only: null,
        skipJudge: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--questions') args.questionsPath = resolve(argv[++i]);
        else if (arg === '--out-dir') args.outDir = resolve(argv[++i]);
        else if (arg === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        else if (arg === '--skip-judge') args.skipJudge = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node scripts/eval/run-eval.ts [--skip-judge] [--only Q01,Q05] [--questions PATH] [--out-dir PATH]');
            process.exit(0);
        }
    }
    return args;
}

async function loadQuestions(path: string): Promise<Question[]> {
    const raw = await readFile(path, 'utf8');
    const parsed = yaml.load(raw) as Question[];
    if (!Array.isArray(parsed)) throw new Error(`Erwartete Liste in ${path}`);
    return parsed;
}

function fmtVerdictLine(scored: ScoredResult[]): string {
    const a = scored.find((s) => s.variant === 'A');
    const bn = scored.find((s) => s.variant === 'B-naive');
    const bb_a = scored.find((s) => s.variant === 'B-boosted' && s.scoreType === 'answer');
    const bb_r = scored.find((s) => s.variant === 'B-boosted' && s.scoreType === 'retrieval');
    const fmt = (s?: ScoredResult) =>
        s ? `${s.verdict.padEnd(7)} ${String(s.latencyMs).padStart(5)}ms` : '–'.padEnd(15);
    return `A=${fmt(a)} | Bn=${fmt(bn)} | Bb-ans=${fmt(bb_a)} | Bb-ret=${fmt(bb_r)}`;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const env = readEnv();

    const allQuestions = await loadQuestions(args.questionsPath);
    const questions = args.only
        ? allQuestions.filter((q) => args.only!.includes(q.id))
        : allQuestions;
    if (questions.length === 0) {
        throw new Error(`Keine Fragen ausgewählt (only=${args.only?.join(',') ?? 'alle'})`);
    }

    const cachePath = resolve(args.outDir, '.judge-cache.json');
    await loadJudgeCache(cachePath);

    const startedAt = new Date().toISOString();
    const runId = startedAt.replace(/[:.]/g, '-').replace(/Z$/, 'Z');

    console.log(`Eval-Run ${runId}`);
    console.log(`Fragen: ${questions.length} (${args.only ? args.only.join(',') : 'alle'})`);
    console.log(`LLM-Judge: ${args.skipJudge ? 'aus' : 'an'}`);
    console.log('');

    const scoringOpts: ScoringOptions = {
        skipJudge: args.skipJudge,
        apiKey: env.anthropicApiKey,
    };

    const perQuestion: { question: Question; results: ScoredResult[] }[] = [];
    for (const q of questions) {
        process.stdout.write(`  ${q.id} (${q.category.padEnd(18)}) ... `);
        const a = await runVariantA(env, q);
        const bn = await runVariantBNaive(env, q);
        const bb = await runVariantBBoosted(env, q);

        const scored: ScoredResult[] = [];
        scored.push(...(await scoreResult(a, q, scoringOpts)));
        scored.push(...(await scoreResult(bn, q, scoringOpts)));
        scored.push(...(await scoreResult(bb, q, scoringOpts)));

        perQuestion.push({ question: q, results: scored });
        console.log(fmtVerdictLine(scored));
    }

    await saveJudgeCache();
    const finishedAt = new Date().toISOString();

    const report = buildReport(runId, startedAt, finishedAt, perQuestion);
    const { jsonPath, mdPath } = await writeReports(args.outDir, runId, report);

    const s = report.summary.perCondition;
    console.log('');
    console.log('Summary:');
    console.log(`  A (Antwort):              PASS ${s.A.PASS}, PARTIAL ${s.A.PARTIAL}, FAIL ${s.A.FAIL}`);
    console.log(`  B-naive (Retrieval):      PASS ${s['B-naive'].PASS}, PARTIAL ${s['B-naive'].PARTIAL}, FAIL ${s['B-naive'].FAIL}`);
    console.log(`  B-boosted (Antwort):      PASS ${s['B-boosted-answer'].PASS}, PARTIAL ${s['B-boosted-answer'].PARTIAL}, FAIL ${s['B-boosted-answer'].FAIL}`);
    console.log(`  B-boosted (Retrieval):    PASS ${s['B-boosted-retrieval'].PASS}, PARTIAL ${s['B-boosted-retrieval'].PARTIAL}, FAIL ${s['B-boosted-retrieval'].FAIL}`);
    console.log('');
    console.log(`JSON: ${jsonPath}`);
    console.log(`MD:   ${mdPath}`);
}

await main();
