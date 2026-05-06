// Drei Bedingungen als Funktionen.  Sequentiell aufgerufen vom Entrypoint.

import { askAgent, callApexRetriever } from './agents.ts';
import type { SalesforceEnv } from './auth.ts';
import type { ConditionResult, Question, Variant } from './types.ts';

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; latencyMs: number }> {
    const t0 = Date.now();
    try {
        const value = await fn();
        return { value, latencyMs: Date.now() - t0 };
    } catch (e) {
        const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        return { error, latencyMs: Date.now() - t0 };
    }
}

export async function runVariantA(env: SalesforceEnv, q: Question): Promise<ConditionResult> {
    const r = await timed(() => askAgent(env, env.agentAId, q.question));
    return buildResult('A', q, r, { answer: r.value });
}

export async function runVariantBNaive(env: SalesforceEnv, q: Question): Promise<ConditionResult> {
    const r = await timed(() => callApexRetriever(env, 'naive', q.question));
    return buildResult('B-naive', q, r, {
        retrievedChunks: r.value?.chunks,
        diagnosticInfo: r.value?.diagnosticInfo,
    });
}

export async function runVariantBBoosted(env: SalesforceEnv, q: Question): Promise<ConditionResult> {
    // B-boosted misst Antwort-Qualität (Agent B) UND Retrieval-Qualität
    // (Apex /boosted) – wir laufen beide Calls.
    const apex = await timed(() => callApexRetriever(env, 'boosted', q.question));
    const agent = await timed(() => askAgent(env, env.agentBId, q.question));

    return {
        variant: 'B-boosted',
        questionId: q.id,
        answer: agent.value,
        retrievedChunks: apex.value?.chunks,
        diagnosticInfo: apex.value?.diagnosticInfo,
        latencyMs: apex.latencyMs + agent.latencyMs,
        error: agent.error ?? apex.error,
    };
}

function buildResult<V extends Variant>(
    variant: V,
    q: Question,
    timed: { value?: unknown; error?: string; latencyMs: number },
    payload: Partial<ConditionResult>,
): ConditionResult {
    return {
        variant,
        questionId: q.id,
        latencyMs: timed.latencyMs,
        error: timed.error,
        ...payload,
    };
}
