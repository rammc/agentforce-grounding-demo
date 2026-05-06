// Agent Runtime API Client + Apex REST Client.
//
// [Inference] Agent Runtime API Pfad in Spring '26:
//   Base:        https://api.salesforce.com/einstein/ai-agent/v1
//   Create:      POST /agents/{agentId}/sessions
//   Send msg:    POST /sessions/{sessionId}/messages
//   End:         DELETE /sessions/{sessionId}
// Quelle: sf-ai-agentforce-testing/references/agent-api-reference.md.
// Bei API-Pfad-Drift nur AGENT_API_BASE anpassen.

import { randomUUID } from 'node:crypto';
import { getAccessToken, type SalesforceEnv } from './auth.ts';
import type { Chunk } from './types.ts';

const AGENT_API_BASE = 'https://api.salesforce.com/einstein/ai-agent/v1';

interface AgentApiActionResult {
    type?: string;
    value?: {
        formattedContent?: string;
        diagnosticInfo?: string;
    };
}

interface AgentApiMessage {
    type: string;
    message?: string;
    result?: AgentApiActionResult[];
    citedReferences?: unknown[];
}

interface AgentSessionResponse {
    sessionId: string;
    messages?: AgentApiMessage[];
}

interface AgentMessageResponse {
    messages?: AgentApiMessage[];
}

/**
 * Schickt eine Single-Turn-Frage an einen Agent: Session öffnen, Message senden,
 * finale Inform-Message extrahieren, Session schließen.  Pro Frage eine neue
 * Session, damit kein State zwischen Fragen leakt.
 */
export async function askAgent(env: SalesforceEnv, agentId: string, question: string): Promise<string> {
    const { token } = await getAccessToken(env);

    // 1. Session erzeugen.
    const createUrl = `${AGENT_API_BASE}/agents/${agentId}/sessions`;
    const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            externalSessionKey: randomUUID(),
            instanceConfig: { endpoint: env.instanceUrl },
            streamingCapabilities: { chunkTypes: ['Text'] },
            bypassUser: true,
        }),
    });
    if (!createRes.ok) {
        throw new Error(`Agent-Session-Create fehlgeschlagen (${createRes.status}): ${await createRes.text()}`);
    }
    const session = (await createRes.json()) as AgentSessionResponse;

    let answer = '';
    try {
        // 2. Message schicken.
        const msgUrl = `${AGENT_API_BASE}/sessions/${session.sessionId}/messages`;
        const msgRes = await fetch(msgUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: { sequenceId: 1, type: 'Text', text: question },
            }),
        });
        if (!msgRes.ok) {
            throw new Error(`Agent-Message fehlgeschlagen (${msgRes.status}): ${await msgRes.text()}`);
        }
        const data = (await msgRes.json()) as AgentMessageResponse;
        answer = extractFinalText(data.messages ?? []);
    } finally {
        // 3. Session schließen (best effort, Fehler nicht eskalieren).
        try {
            await fetch(`${AGENT_API_BASE}/sessions/${session.sessionId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
        } catch {
            /* ignore */
        }
    }

    return answer;
}

/**
 * Filtert aus dem messages-Array die erste 'Inform'-Message heraus.
 * Tool-Calls und Zwischenschritte (Confirm, ProgressIndicator) werden
 * ignoriert; falls keine Inform-Message gefunden wird, geben wir den
 * Text der letzten Message zurück.
 */
function extractFinalText(messages: AgentApiMessage[]): string {
    for (const m of messages) {
        if (m.type === 'Inform' && typeof m.message === 'string' && m.message.trim()) {
            return m.message;
        }
    }
    const last = messages[messages.length - 1];
    return last?.message ?? '';
}

// ---------------------------------------------------------------------------
// Apex REST Client – RetrieverRestEndpoint
// ---------------------------------------------------------------------------

interface ApexResponse {
    results?: {
        content?: string;
        sourceFile?: string;
        sourceSection?: string;
        productIds?: string;
        docType?: string;
        score?: number;
    }[];
    diagnosticInfo?: string;
}

export interface RetrieverInvocation {
    chunks: Chunk[];
    diagnosticInfo: string;
}

export async function callApexRetriever(
    env: SalesforceEnv,
    mode: 'boosted' | 'naive',
    query: string,
    topK = 5,
): Promise<RetrieverInvocation> {
    const { token, instanceUrl } = await getAccessToken(env);
    const url = `${instanceUrl}/services/apexrest/aerolift/retrieve/${mode}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, topK }),
    });
    if (!res.ok) {
        throw new Error(`Apex REST ${mode} fehlgeschlagen (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as ApexResponse;
    return {
        chunks: (data.results ?? []).map((r) => ({
            content: r.content ?? '',
            sourceFile: r.sourceFile ?? '',
            sourceSection: r.sourceSection ?? '',
            productIds: r.productIds ?? '',
            docType: r.docType ?? '',
            score: typeof r.score === 'number' ? r.score : null,
        })),
        diagnosticInfo: data.diagnosticInfo ?? '',
    };
}
