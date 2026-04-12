/**
 * create-score-confirmation-template.js
 *
 * One-time script: creates the score_confirmation WhatsApp Content Template
 * in Twilio, then submits it for Meta UTILITY approval.
 *
 * Template body (5 variables):
 *   {{1}} = submitting team name   (e.g. "ts2")
 *   {{2}} = home team name
 *   {{3}} = away team name
 *   {{4}} = date formatted         (e.g. "20 Mar")
 *   {{5}} = score string           (e.g. "ts2 6 – 3 ts4")
 *
 * Quick-reply buttons:
 *   "Correct"      → id: confirm_score
 *   "Update Score" → id: update_score
 *
 * Usage:
 *   TWILIO_ACCOUNT_SID=ACxxx TWILIO_AUTH_TOKEN=xxx node create-score-confirmation-template.js
 *
 * After running, copy the printed SID into TEMPLATE_SIDS.score_confirmation in index.js.
 * Meta approval typically takes minutes–hours for UTILITY category.
 */

const https = require('https');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.');
  process.exit(1);
}

const INDEX_PATH = require('path').join(__dirname, 'index.js');

// ── Template definition ────────────────────────────────────────────────────
// 3 variables — Meta requires surrounding text to be proportionally longer than variable count.
// {{1}} = submitting team name  (e.g. "ts2")
// {{2}} = match description     (e.g. "ts2 vs ts4 on 20 Mar")
// {{3}} = score string          (e.g. "ts2 6 – 3 ts4")
const template = {
  friendly_name: 'score_confirmation_v2',
  language:      'en',
  variables:     { '1': 'Team A', '2': 'Team A vs Team B on 20 Mar', '3': 'Team A 6 - 3 Team B' },
  types: {
    'twilio/quick-reply': {
      body: 'Court Campus\nScore confirmation needed.\n\n{{1}} submitted the result for {{2}}:\n\n{{3}}\n\nPlease tap a button below to confirm the score is correct, or update it with the correct result.',
      actions: [
        { title: 'Correct',      id: 'confirm_score' },
        { title: 'Update Score', id: 'update_score'  },
      ],
    },
  },
};

// ── REST helper ───────────────────────────────────────────────────────────
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    const req = https.request(
      {
        hostname: 'content.twilio.com',
        path,
        method,
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type':  'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('Creating score_confirmation template…');
  const create = await apiRequest('POST', '/v1/Content', template);
  if (create.status !== 201) {
    console.error('Create failed:', JSON.stringify(create.body, null, 2));
    process.exit(1);
  }

  const sid = create.body.sid;
  console.log(`✅ Template created — SID: ${sid}`);
  console.log('   Submitting for Meta UTILITY approval…');

  const approve = await apiRequest(
    'POST',
    `/v1/Content/${sid}/ApprovalRequests/whatsapp`,
    { name: 'score_confirmation_v2', category: 'UTILITY' }
  );
  if (approve.status !== 202 && approve.status !== 200) {
    console.error('Approval request failed:', JSON.stringify(approve.body, null, 2));
    console.log(`\nTemplate SID ${sid} created but approval not submitted.`);
    console.log(`Submit manually at: https://console.twilio.com/us1/develop/sms/content-template-builder`);
    process.exit(1);
  }

  console.log('✅ Approval request submitted.');
  console.log(`\nNext: update TEMPLATE_SIDS.score_confirmation in index.js:`);
  console.log(`  score_confirmation: '${sid}',`);

  // Auto-patch index.js
  try {
    const fs = require('fs');
    let src = fs.readFileSync(INDEX_PATH, 'utf8');
    src = src.replace(
      /score_confirmation:\s*'HX_FILL_score_confirmation'/,
      `score_confirmation: '${sid}'`
    );
    fs.writeFileSync(INDEX_PATH, src);
    console.log('✅ index.js patched automatically.');
  } catch (e) {
    console.warn('Could not auto-patch index.js:', e.message);
    console.log('Please update it manually.');
  }
})();
