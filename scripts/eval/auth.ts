// OAuth 2.0 Client Credentials Flow gegen die Salesforce-Org.
// Token wird einmal pro Run geholt und im Modul-Scope gehalten.

import 'dotenv/config';

interface TokenResponse {
    access_token: string;
    instance_url: string;
    token_type: string;
}

let cachedToken: string | null = null;
let cachedInstanceUrl: string | null = null;

export interface SalesforceEnv {
    instanceUrl: string;
    clientId: string;
    clientSecret: string;
    agentAId: string;
    agentBId: string;
    anthropicApiKey: string;
}

export function readEnv(): SalesforceEnv {
    const required = [
        'SF_INSTANCE_URL',
        'SF_CLIENT_ID',
        'SF_CLIENT_SECRET',
        'AGENT_A_ID',
        'AGENT_B_ID',
        'ANTHROPIC_API_KEY',
    ] as const;
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        throw new Error(
            `Fehlende Umgebungsvariablen: ${missing.join(', ')}. ` +
                `Siehe .env.example und DEPLOY.md Schritt 6.5.`,
        );
    }
    return {
        instanceUrl: process.env.SF_INSTANCE_URL!.replace(/\/$/, ''),
        clientId: process.env.SF_CLIENT_ID!,
        clientSecret: process.env.SF_CLIENT_SECRET!,
        agentAId: process.env.AGENT_A_ID!,
        agentBId: process.env.AGENT_B_ID!,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    };
}

export async function getAccessToken(env: SalesforceEnv): Promise<{ token: string; instanceUrl: string }> {
    if (cachedToken && cachedInstanceUrl) {
        return { token: cachedToken, instanceUrl: cachedInstanceUrl };
    }
    const tokenUrl = `${env.instanceUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.clientId,
        client_secret: env.clientSecret,
    });
    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OAuth-Token-Anfrage fehlgeschlagen: ${res.status} ${res.statusText} – ${text}`);
    }
    const data = (await res.json()) as TokenResponse;
    cachedToken = data.access_token;
    // Token-Response enthält die kanonische instance_url; falls leer, fallen wir zurück.
    cachedInstanceUrl = data.instance_url || env.instanceUrl;
    return { token: cachedToken, instanceUrl: cachedInstanceUrl };
}
