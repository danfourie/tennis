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
  return `${icon} *Court Campus*\n${notif.title}\n${notif.body}\n\n🔗 ${APP_URL}`;
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

      if (USE_CONTENT_TEMPLATES) {
        const tpl = _buildTemplate(notif);
        if (tpl) {
          msgParams.contentSid       = tpl.contentSid;
          msgParams.contentVariables = tpl.contentVariables;
        } else {
          // Fallback to plain text if no template mapped
          msgParams.body = _buildTextMessage(notif);
        }
      } else {
        msgParams.body = _buildTextMessage(notif);
      }

      const msg = await client.messages.create(msgParams);
      console.log(`[WhatsApp] Sent ${notif.type} to ${phone} — SID: ${msg.sid} status: ${msg.status} errorCode: ${msg.errorCode || 'none'} errorMessage: ${msg.errorMessage || 'none'}`);

      // For score reminders: store a pending-score record so a WhatsApp reply
      // of the form "HOME-AWAY" (e.g. "6-3") can update the fixture directly.
      if (notif.type === 'score_reminder' && notif.fixtureId && notif.leagueId) {
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 h
        await admin.firestore().doc(`whatsappPendingScores/${phone}`).set({
          fixtureId:    notif.fixtureId,
          leagueId:     notif.leagueId,
          homeTeam:     notif.homeTeam     || '',
          awayTeam:     notif.awayTeam     || '',
          homeSchoolId: notif.homeSchoolId || null,
          awaySchoolId: notif.awaySchoolId || null,
          sentAt:       admin.firestore.FieldValue.serverTimestamp(),
          expiresAt,
        });
        console.log(`[WhatsApp] Pending score stored for ${phone} fixture ${notif.fixtureId}`);
      }
    } catch (err) {
      console.error(`[WhatsApp] Send failed for ${phone}:`, err.message);
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

  // ── Score reply detection ───────────────────────────────────────────────
  // Accept only strict HOME-AWAY format: one to three digits, a hyphen, one to
  // three digits — no spaces, no other separators.
  const noSpace = rawBody.replace(/\s/g, '');
  const scoreMatch = noSpace.match(/^(\d{1,3})-(\d{1,3})$/);

  // Detect common near-miss formats and give specific guidance
  const nearMiss = !scoreMatch && (
    /^\d+\s*[-:,/]\s*\d+$/.test(rawBody) ||  // spaces / wrong separator
    /^\d{1,3}\s+\d{1,3}$/.test(rawBody)       // "6 3"
  );
  if (nearMiss) {
    return twiml(
      '⚠️ Score format not recognised.\n' +
      'Please reply using HOME-AWAY (digits only, hyphen separator).\n' +
      'Example: 6-3 or 42-12'
    );
  }

  if (scoreMatch) {
    const homeScore = parseInt(scoreMatch[1], 10);
    const awayScore = parseInt(scoreMatch[2], 10);

    if (homeScore > 999 || awayScore > 999) {
      return twiml('❌ Score values too large. Please enter realistic scores (e.g. 6-3 or 42-12).');
    }

    // Look up pending score request keyed on E.164 phone
    const pendingRef = db.doc(`whatsappPendingScores/${e164}`);
    const pending    = await pendingRef.get();

    if (!pending.exists) {
      return twiml(
        '❓ No score request is pending for your number.\n' +
        `Please enter the score in the app: ${APP_URL}`
      );
    }

    const { fixtureId, leagueId, homeTeam, awayTeam, expiresAt } = pending.data();

    if (expiresAt && new Date() > new Date(expiresAt.toMillis ? expiresAt.toMillis() : expiresAt)) {
      await pendingRef.delete();
      return twiml(
        '⏰ Score request has expired (48 h window).\n' +
        `Please enter the score in the app: ${APP_URL}`
      );
    }

    try {
      const leagueRef = db.doc(`leagues/${leagueId}`);
      const leagueDoc = await leagueRef.get();
      if (!leagueDoc.exists) throw new Error('League not found');

      const fixtures = leagueDoc.data().fixtures || [];
      const idx = fixtures.findIndex(f => f.id === fixtureId);
      if (idx === -1) throw new Error('Fixture not found');

      // If a score already exists, confirm the overwrite in the reply
      const prev = fixtures[idx].homeScore != null
        ? ` (overwrites previous ${fixtures[idx].homeScore}-${fixtures[idx].awayScore})`
        : '';

      fixtures[idx].homeScore = homeScore;
      fixtures[idx].awayScore = awayScore;
      await leagueRef.update({ fixtures });

      // Clean up pending entry
      await pendingRef.delete();

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
      return twiml(
        `✅ Score received and saved!\n\n` +
        `${homeTeam}  ${homeScore}  –  ${awayScore}  ${awayTeam}` +
        `${prev}\n\n` +
        `Need to correct it? Log in to the app and update the score there:\n` +
        `🔗 ${APP_URL}`
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

    const sid   = TWILIO_SID.value();
    const token = TWILIO_TOKEN.value();
    const from  = TWILIO_FROM.value(); // e.g. whatsapp:+13186531674
    if (!sid || !token) return { count: 0, cost: '0.00', currency: 'USD', balance: null };

    const client  = twilio(sid, token);
    const https   = require('https');
    const now     = new Date();
    const start   = new Date(now.getFullYear(), now.getMonth(), 1);

    // ── Balance via REST (SDK v5 removed the balance() sub-resource) ──────────
    const balancePromise = new Promise(resolve => {
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const req  = https.request({
        hostname: 'api.twilio.com',
        path:     `/2010-04-01/Accounts/${sid}/Balance.json`,
        headers:  { Authorization: `Basic ${auth}` },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });

    // ── WhatsApp message count + actual cost from messages list ───────────────
    const msgsPromise = client.messages.list({
      from:          from,
      dateSentAfter: start,
      limit:         1000,
    }).catch(() => []);

    const [balanceData, msgs] = await Promise.all([balancePromise, msgsPromise]);

    const count    = msgs.length;
    const cost     = msgs.reduce((sum, m) => sum + Math.abs(parseFloat(m.price || '0')), 0);
    const currency = msgs.length > 0 ? (msgs[0].priceUnit || 'USD') : 'USD';

    return {
      count,
      cost:            cost.toFixed(4),
      currency,
      balance:         balanceData ? parseFloat(balanceData.balance).toFixed(2) : null,
      balanceCurrency: balanceData ? (balanceData.currency || 'USD') : 'USD',
    };
  }
);
