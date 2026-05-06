// Diagnostic helper: attempt to create a session against AGENT_B_ID and dump
// the raw response. Quickest way to distinguish "agent inactive" (404
// "No valid version available") from "auth misconfigured" (400/401) without
// going through the rest of the runtime calls.
//
// Usage: node scripts/diag-sess.mjs
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const tokenResp = await fetch(`${process.env.SF_INSTANCE_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
    }),
});
const { access_token } = await tokenResp.json();

const sessRes = await fetch(`https://api.salesforce.com/einstein/ai-agent/v1/agents/${process.env.AGENT_B_ID}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
        externalSessionKey: randomUUID(),
        instanceConfig: { endpoint: process.env.SF_INSTANCE_URL },
        streamingCapabilities: { chunkTypes: ['Text'] },
        bypassUser: true,
    }),
});
console.log('Status:', sessRes.status);
const text = await sessRes.text();
console.log(text);
