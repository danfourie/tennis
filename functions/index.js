'use strict';

/**
 * Court Campus — Firebase Cloud Functions
 * WhatsApp integration via Twilio WhatsApp Business API
 *
 * SETUP (one-time):
 *   firebase functions:secrets:set TWILIO_ACCOUNT_SID
 *   firebase functions:secrets:set TWILIO_AUTH_TOKEN
 *   firebase functions:secrets:set TWILIO_WHATSAPP_FROM   # e.g. whatsapp:+14155238886
 *
 * DEPLOY:
 *   firebase deploy --only functions
 *
 * WEBHOOK URL (register in Twilio Console → Messaging → WhatsApp → Sender → Webhook):
 *   https://us-central1-tennissa-planner.cloudfunctions.net/whatsappWebhook
 *
 * SWITCHING TO APPROVED TEMPLATES (production):
 *   1. Set USE_CONTENT_TEMPLATES = true below
 *   2. Fill in each TEMPLATE_SIDS entry with the HX... SID from
 *      Twilio Console → Content Template Builder
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, onRequest }  = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin  = require('firebase-admin');
const twilio = require('twilio');

admin.initializeApp();

// ── Secrets ──────────────────────────────────────────────────────────────────
// Set via: firebase functions:secrets:set SECRET_NAME
const TWILIO_SID   = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_FROM  = defineSecret('TWILIO_WHATSAPP_FROM');

// ── App config ────────────────────────────────────────────────────────────────
const APP_URL = 'https://www.courtcampus.co.za/';

// ── Switch to Content Templates once all templates are approved in Twilio ─────
// false = plain text body (works in sandbox; no template approval needed)
// true  = use pre-approved WhatsApp Content Templates (required for production)
const USE_CONTENT_TEMPLATES = true;

const TEMPLATE_SIDS = {
  booking_approved:      'HXb10a75c6f7da594b48b1d30bf6afc51f',
  booking_rejected:      'HXf2354b8f548abf664a8d8dc996a573ac',
  booking_request:       'HX6bb8d38bb7d309eb538298393487e2a9',
  booking_cancelled:     'HXee12c3a33516b940bf69451dbb79c04d',
  fixture_changed:       'HX0a0982228b2086b1796c24c3a0dff47d',
  fixture_cancelled:     'HX330caa9222ff757a219ff5e1777295bd',
  score_reminder:        'HXf02c97f4030b7e4c0083f0b25fd5fd92',
  league_entry:          'HX06da6c17895c1513873dd8f663545681',
  league_created:        'HX11b97f0a334fc41da1ac39f478af02f2',
  league_start_reminder: 'HXdc7cd1e18ad060dfdc38bba852ee739f',
  team_message:          'HXd54a150764c7f983e7ad1280d264a8ed',
  alt_venue_request:     'HX29ec39a6b13c9501aa6577f7d9a0c829',
  general_message:       'HX1eb854e7b1f131278b709c8028145101',
  registration_invite:   'HX62fe5f398eab47e8c8f7811eb26a0034',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format an ISO date string (YYYY-MM-DD) as "15 Mar" for WhatsApp messages. */
function _fmtDate(iso) {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length < 3) return iso;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(parts[2])} ${months[parseInt(parts[1]) - 1] || ''}`;
}

/** Normalise a South African phone to E.164 format (+27...) */
function _toE164(phone) {
  if (!phone) return null;
  const clean = String(phone).replace(/[\s\-\(\)\.]/g, '');
  if (clean.startsWith('+'))  return clean;
  if (clean.startsWith('27')) return '+' + clean;
  if (clean.startsWith('0'))  return '+27' + clean.slice(1);
  return '+27' + clean;
}

/**
 * Build a plain-text WhatsApp message for a notification.
 * Used in sandbox mode and as fallback.
 */
function _buildTextMessage(notif) {
  const icons = {
    booking_approved:            '✅',
    booking_rejected:            '❌',
    booking_request:             '📋',
    booking_cancelled:           '🚫',
    fixture_changed:             '📅',
    fixture_cancelled:           '🚫',
    score_reminder:              '⏰',
    league_entry:                '🎾',
    league_created:              '🏆',
    league_start_reminder:       '📅',
    team_message:                '💬',
    alt_venue_request:           '🏟️',
    general_message:             '📢',
    team_registration_reminder:  '📝',
  };
  const icon = icons[notif.type] || '🔔';

  // For score reminders, append the reply instruction so the user knows they
  // can submit the score directly here instead of opening the app.
  const replyHint = notif.type === 'score_reminder'
    ? '\n\nReply with your score (e.g. *6-3*, your score first) to record it directly here.'
    : '';

  return `${icon} *Court Campus*\n${notif.title}\n${notif.body}${replyHint}\n\n🔗 ${APP_URL}`;
}

/**
 * Build Content Template params for production mode.
 * Returns { contentSid, contentVariables } or null if no mapping found.
 */
function _buildTemplate(notif) {
  const sid = TEMPLATE_SIDS[notif.type];
  if (!sid || sid.startsWith('HX_FILL')) return null;

  // Variable mapping per template type (matches the {{1}} {{2}} placeholders
  // submitted in Twilio Console → Content Template Builder)
  const vars = {};
  switch (notif.type) {
    // URL is hardcoded in each template body (Meta rejects variables at start/end)
    case 'booking_approved':
    case 'booking_cancelled':
      vars['1'] = notif.venueName  || '';
      vars['2'] = notif.date       || '';
      break;
    case 'booking_rejected':
      vars['1'] = notif.venueName  || '';
      break;
    case 'booking_request':
      vars['1'] = notif.fromName   || '';
      vars['2'] = notif.venueName  || '';
      vars['3'] = notif.date       || '';
      break;
    case 'fixture_changed':
    case 'fixture_cancelled':
      vars['1'] = notif.opponent   || '';
      vars['2'] = notif.date       || '';
      break;
    case 'score_reminder':
      vars['1'] = notif.homeTeam || notif.opponent || '';
      vars['2'] = notif.awayTeam || '';
      vars['3'] = notif.date     || '';   // template: {{3}} = date played
      break;
    case 'league_entry':
      vars['1'] = notif.leagueName || '';
      vars['2'] = notif.status     || '';
      break;
    case 'team_message':
      vars['1'] = notif.fromName   || '';
      vars['2'] = notif.date       || '';
      vars['3'] = notif.body       || '';
      break;
    case 'alt_venue_request':
      vars['1'] = notif.fromName   || '';
      vars['2'] = notif.date       || '';
      break;
    case 'general_message':
    case 'league_created':
    case 'league_start_reminder':
      vars['1'] = notif.title      || '';
      vars['2'] = notif.body       || '';
      break;
    case 'registration_invite':
      vars['1'] = notif.fromName   || '';
      vars['2'] = notif.venueName  || '';  // schoolName in invite context
      break;
    default:
      return null;
  }
  return { contentSid: sid, contentVariables: JSON.stringify(vars) };
}

// ── 1. Outbound: mirror every new notification to WhatsApp ────────────────────
// Fires whenever a document is created in /notifications/{notifId}
exports.onNewNotification = onDocumentCreated(
  {
    document: 'notifications/{notifId}',
    secrets:  [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM],
  },
  async (event) => {
    const notif = event.data.data();

    // Skip WhatsApp reply notifications to avoid infinite loops
    if (notif.type === 'whatsapp_reply') return null;

    // Skip if no recipient uid
    if (!notif.uid) return null;

    // Check global WhatsApp toggle (default ON when field is absent)
    const settingsDoc = await admin.firestore().doc('settings/global').get();
    const settings = settingsDoc.exists ? settingsDoc.data() : {};
    if (settings.whatsappEnabled === false) {
      console.log('[WhatsApp] Disabled by global setting — skipping');
      return null;
    }

    // Look up recipient's phone + opt-in status
    const userDoc = await admin.firestore().doc(`users/${notif.uid}`).get();
    const user = userDoc.exists ? userDoc.data() : null;
    if (!user || !user.phone || !user.whatsappOptIn) return null;

    const phone = _toE164(user.phone);
    if (!phone) return null;

    const sid   = TWILIO_SID.value();
    const token = TWILIO_TOKEN.value();
    const from  = TWILIO_FROM.value();
    if (!sid || !token || !from) {
      console.warn('[WhatsApp] Twilio credentials not configured — skipping');
      return null;
    }

    const client = twilio(sid, token);

    try {
      const msgParams = { from, to: `whatsapp:${phone}` };
      let usedTemplate = false;

      if (USE_CONTENT_TEMPLATES) {
        const tpl = _buildTemplate(notif);
        if (tpl) {
          msgParams.contentSid       = tpl.contentSid;
          msgParams.contentVariables = tpl.contentVariables;
          usedTemplate = true;
        } else {
          msgParams.body = _buildTextMessage(notif);
        }
      } else {
        msgParams.body = _buildTextMessage(notif);
      }

      let msg;
      try {
        msg = await client.messages.create(msgParams);
      } catch (tplErr) {
        // Template send failed (pending approval, rejected, or invalid variables).
        // Fall back to plain text so the message still reaches the recipient.
        if (usedTemplate) {
          console.warn(`[WhatsApp] Template failed for ${notif.type} (${tplErr.message}) — falling back to plain text`);
          delete msgParams.contentSid;
          delete msgParams.contentVariables;
          msgParams.body = _buildTextMessage(notif);
          usedTemplate = false;
          msg = await client.messages.create(msgParams);
        } else {
          throw tplErr;
        }
      }

      console.log(`[WhatsApp] Sent ${notif.type} to ${phone} — SID: ${msg.sid} status: ${msg.status} template: ${usedTemplate} errorCode: ${msg.errorCode || 'none'} errorMessage: ${msg.errorMessage || 'none'}`);

      // For score reminders: add this fixture to the pending-score map so a
      // WhatsApp reply of the form "6-3" can update the correct fixture.
      // Stored as fixtures.{fixtureId} so multiple outstanding fixtures accumulate
      // rather than overwriting each other (a school may have several pending games).
      if (notif.type === 'score_reminder' && notif.fixtureId && notif.leagueId) {
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 h
        await admin.firestore().doc(`whatsappPendingScores/${phone}`).set(
          {
            fixtures: {
              [notif.fixtureId]: {
                leagueId:     notif.leagueId,
                homeTeam:     notif.homeTeam     || '',
                awayTeam:     notif.awayTeam     || '',
                date:         notif.date         || '',
                homeSchoolId: notif.homeSchoolId || null,
                awaySchoolId: notif.awaySchoolId || null,
                expiresAt,
              },
            },
          },
          { merge: true }   // merge into map so sibling fixtures are not overwritten
        );
        console.log(`[WhatsApp] Pending score stored for ${phone} fixture ${notif.fixtureId}`);
      }
    } catch (err) {
      console.error(`[WhatsApp] Send failed for ${phone} type=${notif.type}:`, err.message);
    }
    return null;
  }
);

// ── 2. Outbound: admin sends WhatsApp invite to an unregistered organizer ──────
exports.sendWhatsAppInvite = onCall(
  { secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM] },
  async (request) => {
    if (!request.auth) {
      throw new Error('Unauthenticated');
    }

    // Verify caller is admin/master via Firestore (no custom claims in this app)
    const callerDoc = await admin.firestore().doc(`users/${request.auth.uid}`).get();
    const caller    = callerDoc.exists ? callerDoc.data() : null;
    if (!caller || !['master', 'admin'].includes(caller.role)) {
      throw new Error('Permission denied — admins only');
    }

    const { phone, schoolName, contactName } = request.data || {};
    if (!phone) throw new Error('phone is required');

    const e164 = _toE164(phone);
    if (!e164)  throw new Error('Invalid phone number');

    const sid   = TWILIO_SID.value();
    const token = TWILIO_TOKEN.value();
    const from  = TWILIO_FROM.value();

    const client  = twilio(sid, token);
    const greeting = contactName ? `Hi ${contactName}` : 'Hi';
    const body = [
      `👋 *Court Campus*`,
      `${greeting}, you're invited to join Court Campus — the tennis league planner for ${schoolName || 'your school'}.`,
      ``,
      `Register here: ${APP_URL}`,
    ].join('\n');

    const msg = await client.messages.create({ from, to: `whatsapp:${e164}`, body });
    console.log(`[WhatsApp] Invite sent to ${e164} — SID: ${msg.sid}`);
    return { success: true, sid: msg.sid };
  }
);

// ── 3. Inbound: Twilio webhook — user replied on WhatsApp ─────────────────────
// Register the deployed URL of this function in:
//   Twilio Console → Messaging → WhatsApp → Sender → "A message comes in" → Webhook
//   URL: https://whatsappwebhook-y4qyzqnkpq-uc.a.run.app
exports.whatsappWebhook = onRequest(async (req, res) => {
  const fromRaw = req.body && req.body.From ? String(req.body.From) : null;
  const rawBody = req.body && req.body.Body  ? String(req.body.Body).trim() : null;

  if (!fromRaw || !rawBody) return res.sendStatus(200);

  const fromPhone = fromRaw.replace(/^whatsapp:/i, '');
  const e164      = _toE164(fromPhone) || fromPhone;
  const db        = admin.firestore();

  // Helper: reply via TwiML (Twilio renders this as a WhatsApp message back)
  const twiml = (msg) => {
    res.set('Content-Type', 'text/xml');
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${
        msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      }</Message></Response>`
    );
  };

  // ── Resolve user ────────────────────────────────────────────────────────
  let userDoc = null;
  for (const ph of [fromPhone, e164]) {
    if (!ph) continue;
    const snap = await db.collection('users').where('phone', '==', ph).limit(1).get();
    if (!snap.empty) { userDoc = snap.docs[0]; break; }
  }
  if (!userDoc) {
    console.log(`[WhatsApp] Reply from unrecognised phone: ${fromPhone}`);
    return res.sendStatus(200);
  }
  const user = userDoc.data();

  // ── Load all pending fixtures for this phone ───────────────────────────
  // The pending doc stores a `fixtures` map keyed by fixtureId so multiple
  // outstanding games from the same school accumulate without overwriting.
  const pendingRef  = db.doc(`whatsappPendingScores/${e164}`);
  const pendingDoc  = await pendingRef.get();
  const pendingData = pendingDoc.exists ? pendingDoc.data() : {};
  const fixturesMap = pendingData.fixtures || {};

  // Resolve active (non-expired) fixtures from the map
  const nowMs = Date.now();
  const activeFixtures = Object.entries(fixturesMap)
    .map(([fid, f]) => ({ fixtureId: fid, ...f }))
    .filter(f => {
      if (!f.expiresAt) return true;
      const expMs = f.expiresAt.toMillis
        ? f.expiresAt.toMillis()
        : new Date(f.expiresAt).getTime();
      return nowMs < expMs;
    });

  // Purge expired entries from Firestore (fire-and-forget)
  const expiredIds = Object.keys(fixturesMap)
    .filter(id => !activeFixtures.find(f => f.fixtureId === id));
  if (expiredIds.length) {
    const purge = {};
    expiredIds.forEach(id => { purge[`fixtures.${id}`] = admin.firestore.FieldValue.delete(); });
    pendingRef.update(purge).catch(() => {});
  }

  // ── Near-miss score format detection ───────────────────────────────────
  const noSpace    = rawBody.replace(/\s/g, '');
  const scoreMatch = noSpace.match(/^(\d{1,3})-(\d{1,3})$/);
  const nearMiss   = !scoreMatch && (
    /^\d+\s*[-:,/]\s*\d+$/.test(rawBody) ||   // spaces or wrong separator
    /^\d{1,3}\s+\d{1,3}$/.test(rawBody)        // "6 3"
  );
  if (nearMiss) {
    return twiml(
      '⚠️ Score format not recognised.\n' +
      'Please reply using HOME-AWAY (digits only, hyphen separator).\n' +
      'Example: 6-3 or 42-12'
    );
  }

  // ── Menu selection reply (single digit) ────────────────────────────────
  // When the user has multiple pending fixtures we send a numbered menu.
  // A single-digit reply chooses a match; the next score reply then targets it.
  const menuOrder = Array.isArray(pendingData.menuOrder) ? pendingData.menuOrder : [];
  const numMatch  = rawBody.match(/^(\d+)$/);

  if (numMatch && menuOrder.length > 1) {
    const idx    = parseInt(numMatch[1], 10) - 1;
    const selId  = menuOrder[idx];
    const selFix = selId ? fixturesMap[selId] : null;

    if (!selFix || idx < 0) {
      return twiml(`⚠️ Please reply with a number between 1 and ${menuOrder.length}.`);
    }

    await pendingRef.set({ selectedFixtureId: selId }, { merge: true });
    return twiml(
      `✅ *${selFix.homeTeam} vs ${selFix.awayTeam}* selected.\n` +
      `Now reply with the score, your score first (e.g. *6-3*).`
    );
  }

  // ── Score reply ─────────────────────────────────────────────────────────
  if (scoreMatch) {
    const homeScore = parseInt(scoreMatch[1], 10);
    const awayScore = parseInt(scoreMatch[2], 10);

    if (homeScore > 999 || awayScore > 999) {
      return twiml('❌ Score values too large. Please enter realistic scores (e.g. 6-3 or 42-12).');
    }

    if (activeFixtures.length === 0) {
      return twiml(
        '❓ No score request is pending for your number.\n' +
        `Please enter the score in the app: ${APP_URL}`
      );
    }

    // Determine which fixture to score
    let target = null;

    if (activeFixtures.length === 1) {
      // Only one pending game — unambiguous
      target = activeFixtures[0];
    } else if (
      pendingData.selectedFixtureId &&
      fixturesMap[pendingData.selectedFixtureId] &&
      activeFixtures.find(f => f.fixtureId === pendingData.selectedFixtureId)
    ) {
      // User already picked a fixture from the menu
      target = { fixtureId: pendingData.selectedFixtureId, ...fixturesMap[pendingData.selectedFixtureId] };
    } else {
      // Multiple fixtures, no selection yet — send a numbered menu
      const order = activeFixtures.map(f => f.fixtureId);
      const lines = activeFixtures.map((f, i) =>
        `${i + 1}. ${f.homeTeam} vs ${f.awayTeam}${f.date ? ' · ' + _fmtDate(f.date) : ''}`
      );
      await pendingRef.set(
        { menuOrder: order, selectedFixtureId: null },
        { merge: true }
      );
      return twiml(
        `📋 You have ${activeFixtures.length} matches pending. Reply with the number of the match you are scoring:\n\n` +
        lines.join('\n') +
        '\n\nThen reply with your score (e.g. *6-3*, your score first).'
      );
    }

    // Apply the score to the chosen fixture
    try {
      const { fixtureId, leagueId, homeTeam, awayTeam } = target;
      const leagueRef = db.doc(`leagues/${leagueId}`);
      const leagueDoc = await leagueRef.get();
      if (!leagueDoc.exists) throw new Error('League not found');

      const fixtures = leagueDoc.data().fixtures || [];
      const idx      = fixtures.findIndex(f => f.id === fixtureId);
      if (idx === -1) throw new Error('Fixture not found');

      const prev = fixtures[idx].homeScore != null
        ? ` (overwrites previous ${fixtures[idx].homeScore}-${fixtures[idx].awayScore})`
        : '';

      fixtures[idx].homeScore = homeScore;
      fixtures[idx].awayScore = awayScore;
      await leagueRef.update({ fixtures });

      // Remove this fixture from the pending map; clear menu/selection state
      await pendingRef.update({
        [`fixtures.${fixtureId}`]:            admin.firestore.FieldValue.delete(),
        menuOrder:                            admin.firestore.FieldValue.delete(),
        selectedFixtureId:                    admin.firestore.FieldValue.delete(),
      });

      // Audit log
      await db.collection('auditLog').add({
        action:   'score_submitted',
        category: 'fixture',
        details:  `WhatsApp score: ${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}${prev}`,
        itemId:   fixtureId,
        itemName: `${homeTeam} vs ${awayTeam}`,
        at:       new Date().toISOString(),
        by:       user.uid,
        byName:   user.displayName || fromPhone,
      });

      console.log(`[WhatsApp] Score saved ${homeTeam} ${homeScore}-${awayScore} ${awayTeam} by ${fromPhone}`);

      // Check if more fixtures are still pending
      const remaining = activeFixtures.filter(f => f.fixtureId !== fixtureId);
      const followUp  = remaining.length > 0
        ? `\n\n⏳ You still have ${remaining.length} more match${remaining.length > 1 ? 'es' : ''} awaiting a score — reply with a score when ready.`
        : '';

      return twiml(
        `✅ Score received and saved!\n\n` +
        `${homeTeam}  ${homeScore}  –  ${awayScore}  ${awayTeam}` +
        `${prev}${followUp}\n\n` +
        `Need to correct it? Log in to the app:\n🔗 ${APP_URL}`
      );
    } catch (err) {
      console.error('[WhatsApp] Score update failed:', err.message);
      return twiml(`❌ Could not save the score. Please enter it in the app: ${APP_URL}`);
    }
  }

  // ── Generic reply → store as in-app notification ────────────────────────
  await db.collection('notifications').add({
    uid:       user.uid,
    type:      'whatsapp_reply',
    title:     '📱 WhatsApp message',
    body:      rawBody,
    read:      false,
    leagueId:  null,
    fixtureId: null,
    createdAt: new Date().toISOString(),
    createdBy: null,
    fromName:  fromPhone,
  });

  console.log(`[WhatsApp] Reply from ${fromPhone} stored for uid ${user.uid}`);
  return res.sendStatus(200);
});

// ── 4. Usage stats: this month's WhatsApp message count + cost ────────────────
exports.getTwilioUsage = onCall(
  { secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM] },
  async (request) => {
    if (!request.auth) throw new Error('Unauthenticated');

    // .trim() is critical — Firebase Secrets can include a trailing newline,
    // which causes ERR_UNESCAPED_CHARACTERS when the SID is interpolated into
    // an HTTPS path, and breaks the Twilio SDK client.
    const sid   = (TWILIO_SID.value()   || '').trim();
    const token = (TWILIO_TOKEN.value() || '').trim();
    const from  = (TWILIO_FROM.value()  || '').trim(); // e.g. whatsapp:+13186531674

    if (!sid || !token) {
      return { count: 0, cost: '0.0000', currency: 'USD', balance: null, balanceCurrency: 'USD' };
    }

    const https = require('https');
    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── Balance via Twilio REST API ───────────────────────────────────────────
    // SDK v5 removed the .balance() sub-resource — call the REST endpoint directly.
    // encodeURIComponent guards against any remaining special chars in the SID.
    const balancePromise = new Promise(resolve => {
      try {
        const auth = Buffer.from(`${sid}:${token}`).toString('base64');
        const req  = https.request({
          hostname: 'api.twilio.com',
          path:     `/2010-04-01/Accounts/${encodeURIComponent(sid)}/Balance.json`,
          method:   'GET',
          headers:  { Authorization: `Basic ${auth}` },
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        });
        req.on('error', (e) => {
          console.error('[Twilio] Balance REST error:', e.message);
          resolve(null);
        });
        req.end();
      } catch (e) {
        console.error('[Twilio] Balance request setup error:', e.message);
        resolve(null);
      }
    });

    // ── WhatsApp message count + cost from messages list ─────────────────────
    // Filter by the WhatsApp sender number for this month only.
    const msgsPromise = (async () => {
      try {
        const client = twilio(sid, token);
        return await client.messages.list({
          from:          from,
          dateSentAfter: start,
          limit:         1000,
        });
      } catch (e) {
        console.error('[Twilio] Messages list error:', e.message);
        return [];
      }
    })();

    const [balanceData, msgs] = await Promise.all([balancePromise, msgsPromise]);

    const count    = msgs.length;
    const cost     = msgs.reduce((sum, m) => sum + Math.abs(parseFloat(m.price || '0')), 0);
    const currency = msgs.length > 0 ? (msgs[0].priceUnit || 'USD') : 'USD';

    console.log(`[Twilio] Usage: ${count} msgs, $${cost.toFixed(4)}, balance: ${balanceData ? balanceData.balance : 'N/A'}`);

    return {
      count,
      cost:            cost.toFixed(4),
      currency,
      balance:         balanceData && balanceData.balance != null
                         ? parseFloat(balanceData.balance).toFixed(2)
                         : null,
      balanceCurrency: balanceData ? (balanceData.currency || 'USD') : 'USD',
    };
  }
);
