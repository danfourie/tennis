'use strict';
/**
 * One-time setup script — creates the score_reminder quick-reply template
 * in Twilio and submits it to Meta for approval.
 *
 * Run from the functions/ directory:
 *   TWILIO_ACCOUNT_SID=ACxxx TWILIO_AUTH_TOKEN=xxx node create-score-reminder-template.js
 *
 * On success the script prints the new Content SID and automatically
 * patches TEMPLATE_SIDS.score_reminder in index.js.
 */

const twilio = require('twilio');
const fs     = require('fs');
const path   = require('path');

const sid   = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;

if (!sid || !token) {
  console.error('ERROR: Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.');
  process.exit(1);
}

const client = twilio(sid, token);

async function main() {
  console.log('Creating score_reminder quick-reply template…');

  // ── Create the Content Template ─────────────────────────────────────────
  // Variables:
  //   {{1}} = home team name       e.g. "Bishops"
  //   {{2}} = away team name       e.g. "SACS"
  //   {{3}} = match date           e.g. "20 Mar"
  //   {{4}} = fixtureId (hidden)   embedded in button payload so the webhook
  //           knows which fixture to update when the button is tapped.
  //
  // Button id uses variable {{4}} → ButtonPayload = "score_<fixtureId>"
  //
  // A twilio/text fallback is included for channels that don't render buttons
  // (required by Meta for multi-channel templates).
  const template = await client.content.v1.contents.create({
    friendlyName: 'score_reminder_v2',
    language:     'en',
    variables:    { '1': 'Bishops', '2': 'SACS', '3': '20 Mar', '4': 'fixture_id' },
    types: {
      'twilio/quick-reply': {
        body: [
          '⏰ *Court Campus*',
          'Score reminder: {{1}} vs {{2}} played on {{3}}.',
          'Please submit the match result.',
        ].join('\n'),
        actions: [
          {
            title: '📊 Submit Score',   // max 20 chars — tapping this starts the flow
            id:    'score_{{4}}',       // ButtonPayload = "score_<fixtureId>"
          },
        ],
      },
      'twilio/text': {
        body: [
          '⏰ *Court Campus*',
          'Score reminder: {{1}} vs {{2}} played on {{3}}.',
          'Reply with the score (e.g. *6-3*, {{1}}\'s score first) or log in: https://www.courtcampus.co.za/',
        ].join('\n'),
      },
    },
  });

  console.log(`\n✅ Template created — SID: ${template.sid}`);
  console.log(`   Name       : ${template.friendlyName}`);
  console.log(`   Date created: ${template.dateCreated}`);

  // ── Submit for Meta approval (UTILITY category) ──────────────────────────
  // UTILITY = transactional / service (cheaper than MARKETING, no opt-in fee)
  console.log('\nSubmitting for Meta approval (UTILITY category)…');
  try {
    const approval = await client.content.v1
      .contents(template.sid)
      .approvalRequests
      .create({
        name:     'score_reminder_v2',
        category: 'UTILITY',
      });
    console.log(`✅ Approval request submitted — status: ${approval.status}`);
    console.log('   Meta typically approves UTILITY templates within a few hours.');
  } catch (approvalErr) {
    console.warn(`⚠️  Approval request failed: ${approvalErr.message}`);
    console.warn('   Submit manually in Twilio Console → Content Template Builder.');
  }

  // ── Patch TEMPLATE_SIDS.score_reminder in index.js ──────────────────────
  const indexPath = path.join(__dirname, 'index.js');
  let src = fs.readFileSync(indexPath, 'utf8');

  const oldLine = /score_reminder:\s+'HX[a-f0-9]{32}',/;
  const newLine = `score_reminder:        '${template.sid}',  // quick-reply template v2`;

  if (oldLine.test(src)) {
    src = src.replace(oldLine, newLine);
    fs.writeFileSync(indexPath, src, 'utf8');
    console.log(`\n✅ Patched TEMPLATE_SIDS.score_reminder → ${template.sid} in index.js`);
    console.log('   Deploy when Meta approval is granted:');
    console.log('   firebase deploy --only functions');
  } else {
    console.warn('\n⚠️  Could not auto-patch index.js. Update manually:');
    console.warn(`   score_reminder: '${template.sid}',`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
