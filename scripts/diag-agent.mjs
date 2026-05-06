// Diagnostic helper: send a single question to an Agentforce agent via the
// Agent Runtime API and dump the raw response (messages, action results,
// citations). Used during deploy/troubleshooting to verify the action chain
// without going through the eval harness.
//
// Usage:
//   node scripts/diag-agent.mjs                                 # uses AGENT_B_ID + default Q
//   node scripts/diag-agent.mjs <agentId>                       # custom agent, default Q
//   node scripts/diag-agent.mjs <agentId> "<question>"          # both custom
//   node scripts/diag-agent.mjs '' "<question>"                 # default agent, custom Q
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const agentId = process.argv[2] || process.env.AGENT_B_ID;
const question = process.argv[3] || 'Welche maximale Medientemperatur hat die AL-3000-SX?';

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

const sessRes = await fetch(`https://api.salesforce.com/einstein/ai-agent/v1/agents/${agentId}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
        externalSessionKey: randomUUID(),
        instanceConfig: { endpoint: process.env.SF_INSTANCE_URL },
        streamingCapabilities: { chunkTypes: ['Text'] },
        bypassUser: true,
    }),
});
const sess = await sessRes.json();
console.log('Agent:', agentId);
console.log('Session:', sess.sessionId);

const msgRes = await fetch(`https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sess.sessionId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
        message: { sequenceId: 1, type: 'Text', text: question },
    }),
});
const msg = await msgRes.json();
console.log('\n=== FULL RESPONSE ===');
console.log(JSON.stringify(msg, null, 2));
