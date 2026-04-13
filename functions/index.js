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
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin      = require('firebase-admin');
const twilio     = require('twilio');
const nodemailer = require('nodemailer');

admin.initializeApp();

// ── Secrets ──────────────────────────────────────────────────────────────────
// Set via: firebase functions:secrets:set SECRET_NAME
const TWILIO_SID   = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_FROM  = defineSecret('TWILIO_WHATSAPP_FROM');
// Email: firebase functions:secrets:set EMAIL_USER  (e.g. noreply@courtcampus.co.za)
//        firebase functions:secrets:set EMAIL_PASS  (app password for the SMTP account)
const EMAIL_USER   = defineSecret('EMAIL_USER');
const EMAIL_PASS   = defineSecret('EMAIL_PASS');

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
  score_reminder:        'HX24c495de9ff7f39a1537bba9c10f44da',  // quick-reply v3 — Meta approved 2026-03-27
  score_confirmation:    'HX17d0b678a4f993d76e42ad2d4a3b1a7d',   // v2 — Meta approved
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
      vars['1'] = notif.homeTeam  || notif.opponent || '';
      vars['2'] = notif.awayTeam  || '';
      vars['3'] = notif.date      ? _fmtDate(notif.date) : '';  // human-readable "20 Mar"
      vars['4'] = notif.fixtureId || '';  // template defines 4 vars; {{4}} unused in body/button
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
          console.warn(`[WhatsApp] Template failed for ${notif.type} — code: ${tplErr.code} status: ${tplErr.status} message: ${tplErr.message} moreInfo: ${tplErr.moreInfo} — falling back to plain text`);
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
      // WhatsApp reply can update the correct fixture.
      // • msgSid is stored so that a native WhatsApp "Reply" to this exact
      //   message lets the webhook identify the fixture without any menu.
      // • The fixtures map accumulates all pending fixtures per phone so that
      //   a plain new message still works via numbered-menu fallback.
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
                msgSid:       msg.sid,           // used to correlate a native Reply
                expiresAt,
              },
            },
          },
          { merge: true }
        );
        console.log(`[WhatsApp] Pending score stored for ${phone} fixture ${notif.fixtureId} msgSid ${msg.sid}`);
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

    const client = twilio(sid, token);
    const msgParams = { from, to: `whatsapp:${e164}` };
    let usedTemplate = false;

    if (USE_CONTENT_TEMPLATES && TEMPLATE_SIDS.registration_invite) {
      msgParams.contentSid       = TEMPLATE_SIDS.registration_invite;
      msgParams.contentVariables = JSON.stringify({ '1': contactName || '', '2': schoolName || '' });
      usedTemplate = true;
    } else {
      const greeting = contactName ? `Hi ${contactName}` : 'Hi';
      msgParams.body = [
        `👋 *Court Campus*`,
        `${greeting}, you're invited to join Court Campus — the tennis league planner for ${schoolName || 'your school'}.`,
        ``,
        `Register here: ${APP_URL}`,
      ].join('\n');
    }

    let msg;
    try {
      msg = await client.messages.create(msgParams);
    } catch (tplErr) {
      if (usedTemplate) {
        console.warn(`[WhatsApp] Invite template failed — ${tplErr.message} — falling back to plain text`);
        delete msgParams.contentSid;
        delete msgParams.contentVariables;
        const greeting = contactName ? `Hi ${contactName}` : 'Hi';
        msgParams.body = [
          `👋 *Court Campus*`,
          `${greeting}, you're invited to join Court Campus — the tennis league planner for ${schoolName || 'your school'}.`,
          ``,
          `Register here: ${APP_URL}`,
        ].join('\n');
        usedTemplate = false;
        msg = await client.messages.create(msgParams);
      } else {
        throw tplErr;
      }
    }
    console.log(`[WhatsApp] Invite sent to ${e164} — SID: ${msg.sid} template: ${usedTemplate}`);
    return { success: true, sid: msg.sid };
  }
);

// ── 3. Outbound: admin sends email invite to an unregistered organizer ────────
exports.sendEmailInvite = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    if (!request.auth) throw new Error('Unauthenticated');

    const callerDoc = await admin.firestore().doc(`users/${request.auth.uid}`).get();
    const caller    = callerDoc.exists ? callerDoc.data() : null;
    if (!caller || !['master', 'admin'].includes(caller.role)) {
      throw new Error('Permission denied — admins only');
    }

    const { email, contactName, schoolName } = request.data || {};
    if (!email) throw new Error('email is required');

    const user = EMAIL_USER.value();
    const pass = EMAIL_PASS.value();
    if (!user || !pass) throw new Error('Email credentials not configured — set EMAIL_USER and EMAIL_PASS secrets');

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });

    const greeting  = contactName ? `Hi ${contactName}` : 'Hi there';
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: Arial, sans-serif; background: #f4f7fb; margin: 0; padding: 0; }
    .container { max-width: 560px; margin: 32px auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    .header { background: #3b82f6; padding: 28px 32px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 22px; }
    .header p  { color: #dbeafe; margin: 6px 0 0; font-size: 14px; }
    .body { padding: 28px 32px; color: #1e293b; line-height: 1.6; }
    .body p { margin: 0 0 14px; }
    .cta { display: block; margin: 24px 0; text-align: center; }
    .cta a { background: #3b82f6; color: #fff !important; text-decoration: none; padding: 13px 32px; border-radius: 6px; font-size: 15px; font-weight: 600; display: inline-block; }
    .note { background: #f0f9ff; border-left: 4px solid #38bdf8; border-radius: 4px; padding: 12px 16px; font-size: 13px; color: #0369a1; margin: 20px 0 0; }
    .footer { text-align: center; padding: 16px 32px; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎾 Court Campus</h1>
      <p>Tennis League Management Platform</p>
    </div>
    <div class="body">
      <p>${greeting},</p>
      <p>You've been invited to join <strong>Court Campus</strong> — the online platform used by <strong>${schoolName || 'your school'}</strong> to manage tennis leagues, fixtures, scores, and venue bookings.</p>
      <p>As a registered user you'll be able to:</p>
      <ul>
        <li>View and manage your school's fixtures and results</li>
        <li>Receive match reminders and schedule updates</li>
        <li>Submit scores and track league standings</li>
        <li>Coordinate venue bookings</li>
      </ul>
      <div class="cta">
        <a href="${APP_URL}">Register on Court Campus →</a>
      </div>
      <div class="note">
        📲 <strong>Also check your WhatsApp</strong> — you'll receive a separate WhatsApp message prompting you to register. Either the link above or the WhatsApp link will get you set up.
      </div>
    </div>
    <div class="footer">
      Court Campus · <a href="${APP_URL}" style="color:#94a3b8">${APP_URL}</a><br>
      You received this because an admin invited you on behalf of ${schoolName || 'your school'}.
    </div>
  </div>
</body>
</html>`;

    const text = [
      `${greeting},`,
      ``,
      `You've been invited to join Court Campus — the online platform used by ${schoolName || 'your school'} to manage tennis leagues, fixtures, scores, and venue bookings.`,
      ``,
      `Register here: ${APP_URL}`,
      ``,
      `Also check your WhatsApp — you'll receive a separate message prompting you to register.`,
    ].join('\n');

    const info = await transporter.sendMail({
      from:    `"Court Campus" <${user}>`,
      to:      email,
      subject: `You're invited to Court Campus${schoolName ? ' — ' + schoolName : ''}`,
      text,
      html,
    });

    console.log(`[Email] Invite sent to ${email} — messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  }
);

// ── 4. Inbound: Twilio webhook — user replied on WhatsApp ─────────────────────
// Register the deployed URL of this function in:
//   Twilio Console → Messaging → WhatsApp → Sender → "A message comes in" → Webhook
//   URL: https://whatsappwebhook-y4qyzqnkpq-uc.a.run.app
exports.whatsappWebhook = onRequest({ secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM] }, async (req, res) => {
  const fromRaw      = req.body && req.body.From          ? String(req.body.From).trim()          : null;
  const rawBody      = req.body && req.body.Body          ? String(req.body.Body).trim()          : null;
  const buttonPayloadRaw = req.body && req.body.ButtonPayload ? String(req.body.ButtonPayload).trim() : null;

  // On approved (non-sandbox) numbers, Meta sometimes delivers quick-reply button taps
  // as a plain Body message (button label text) with no ButtonPayload field.
  // Treat body text equivalent to ButtonPayload for all quick-reply buttons.
  const isSubmitScoreButton =
    buttonPayloadRaw === 'submit_score' ||
    (rawBody && rawBody.toLowerCase() === 'submit score');

  // score_confirmation template buttons — only activate when user has a pending confirmation
  // (guarded later against fixturesMap to avoid false positives from normal messages)
  const isConfirmScore =
    buttonPayloadRaw === 'confirm_score' ||
    (rawBody && /^correct$/i.test(rawBody.trim()));
  const isUpdateScore =
    buttonPayloadRaw === 'update_score' ||
    (rawBody && /^update\s*score$/i.test(rawBody.trim()));

  // Log every inbound event for debugging
  console.log(`[WhatsApp] Inbound — From=${fromRaw || 'none'} Body=${JSON.stringify(rawBody)} ButtonPayload=${JSON.stringify(buttonPayloadRaw)} isSubmitBtn=${isSubmitScoreButton}`);

  // Drop requests with no sender; allow through even if Body is empty (button taps)
  if (!fromRaw) return res.status(200).end();
  if (!rawBody && !buttonPayloadRaw) return res.status(200).end();

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
    return res.status(200).end();
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

  // ── "Submit Score" button tap (quick-reply template) ──────────────────
  // score_reminder_v3 has a STATIC button id = "submit_score" (no variables —
  // Meta rejects templates with variables or emojis in button fields).
  // Fixture identity is established via OriginalRepliedMessageSid: Twilio
  // always includes this when a user taps a quick-reply button (WhatsApp
  // treats button taps as contextual replies to the original message).
  // msgSid is stored in the pending-score fixture record at send time.
  if (isSubmitScoreButton) {
    const origSid = req.body && req.body.OriginalRepliedMessageSid
      ? String(req.body.OriginalRepliedMessageSid) : null;

    console.log(`[WhatsApp] "Submit Score" button tapped — OriginalRepliedMessageSid=${origSid || 'none'}`);

    // Identify fixture: OriginalRepliedMessageSid → msgSid lookup (primary)
    let btnFixture = null;
    if (origSid) {
      const entry = Object.entries(fixturesMap).find(([, f]) => f.msgSid === origSid);
      if (entry) btnFixture = { fixtureId: entry[0], ...entry[1] };
    }

    // Fallback: only one fixture pending — unambiguous
    if (!btnFixture && activeFixtures.length === 1) {
      btnFixture = activeFixtures[0];
    }

    if (btnFixture && activeFixtures.find(f => f.fixtureId === btnFixture.fixtureId)) {
      await pendingRef.set({ awaitingScoreInput: btnFixture.fixtureId }, { merge: true });
      const dateStr = btnFixture.date ? ` · ${_fmtDate(btnFixture.date)}` : '';
      return twiml(
        `⏰ *${btnFixture.homeTeam} vs ${btnFixture.awayTeam}${dateStr}*\n\n` +
        `Reply with the score — *${btnFixture.homeTeam}'s score first*.\n\n` +
        `  If *${btnFixture.homeTeam}* won 6-3 → reply *6-3*\n` +
        `  If *${btnFixture.awayTeam}* won 6-3 → reply *3-6*`
      );
    }

    // Multiple fixtures pending, SID not matched — show a numbered menu
    if (activeFixtures.length > 1) {
      const order = activeFixtures.map(f => f.fixtureId);
      const lines = activeFixtures.map((f, i) =>
        `${i + 1}. ${f.homeTeam} vs ${f.awayTeam}${f.date ? ' · ' + _fmtDate(f.date) : ''}`
      );
      await pendingRef.set({ menuOrder: order, selectedFixtureId: null, awaitingScoreInput: null }, { merge: true });
      return twiml(
        `📋 Multiple matches pending. Which match are you scoring?\n\n` +
        lines.join('\n') + '\n\nReply with the number.'
      );
    }

    return twiml(`❓ No pending score request found — it may have already been submitted.\n🔗 ${APP_URL}`);
  }

  // ── "Correct" button — confirm the pending score ───────────────────────
  // Only fires when the user actually has an awaitingConfirmation fixture,
  // preventing the word "correct" in normal messages from triggering this.
  const hasConfirmPending = Object.values(fixturesMap).some(f => f.awaitingConfirmation);

  if (isConfirmScore && hasConfirmPending) {
    const origSid = req.body && req.body.OriginalRepliedMessageSid
      ? String(req.body.OriginalRepliedMessageSid) : null;

    let confFix = null;
    if (origSid) {
      const e = Object.entries(fixturesMap).find(([, f]) => f.confirmMsgSid === origSid && f.awaitingConfirmation);
      if (e) confFix = { fixtureId: e[0], ...e[1] };
    }
    if (!confFix) {
      const e = Object.entries(fixturesMap).find(([, f]) => f.awaitingConfirmation);
      if (e) confFix = { fixtureId: e[0], ...e[1] };
    }
    if (!confFix) {
      return twiml(`❓ No score awaiting confirmation. It may already have been confirmed.\n🔗 ${APP_URL}`);
    }

    const { fixtureId: cfId, leagueId: cfLeague, homeTeam: cfHome, awayTeam: cfAway,
            homeSchoolId: cfHomeSchool, awaySchoolId: cfAwaySchool,
            pendingHome, pendingAway, submittedBySchoolId } = confFix;
    try {
      const cfLeagueRef = db.doc(`leagues/${cfLeague}`);
      const cfLeagueDoc = await cfLeagueRef.get();
      if (!cfLeagueDoc.exists) throw new Error('League not found');
      const cfFixtures = cfLeagueDoc.data().fixtures || [];
      const cfIdx = cfFixtures.findIndex(f => f.id === cfId);
      if (cfIdx !== -1) {
        cfFixtures[cfIdx].homeScore          = pendingHome;
        cfFixtures[cfIdx].awayScore          = pendingAway;
        cfFixtures[cfIdx].homeTeamVerified   = true;
        cfFixtures[cfIdx].awayTeamVerified   = true;
        cfFixtures[cfIdx].homeTeamSubmission = null;
        cfFixtures[cfIdx].awayTeamSubmission = null;
        cfFixtures[cfIdx].scoreDisputed      = false;
        await cfLeagueRef.update({ fixtures: cfFixtures });
      }
      await db.collection('auditLog').add({
        action: 'score_confirmed', category: 'fixture',
        details: `WhatsApp score confirmed: ${cfHome} ${pendingHome}-${pendingAway} ${cfAway}`,
        itemId: cfId, itemName: `${cfHome} vs ${cfAway}`,
        at: new Date().toISOString(), by: user.uid, byName: user.displayName || fromPhone,
      });

      const cfTwilioSid   = TWILIO_SID.value();
      const cfTwilioToken = TWILIO_TOKEN.value();
      const cfTwilioFrom  = TWILIO_FROM.value();
      const cfWClient     = twilio(cfTwilioSid, cfTwilioToken);
      const cfMsg = `✅ Score confirmed!\n\n${cfHome}  ${pendingHome}  –  ${pendingAway}  ${cfAway}\n\nBoth teams agreed. The result has been recorded.`;

      // Notify the submitting team
      if (submittedBySchoolId) {
        const ss = await db.collection('users').where('schoolId', '==', submittedBySchoolId).get();
        for (const sd of ss.docs) {
          const sph = _toE164(sd.data().phone);
          if (!sph) continue;
          cfWClient.messages.create({ from: cfTwilioFrom, to: `whatsapp:${sph}`, body: cfMsg }).catch(() => {});
          db.doc(`whatsappPendingScores/${sph}`).update({ [`fixtures.${cfId}`]: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
      }
      // Clear all users of the confirming school
      const confirmingSchool = user.schoolId;
      if (confirmingSchool) {
        const cs = await db.collection('users').where('schoolId', '==', confirmingSchool).get();
        for (const cd of cs.docs) {
          const cph = _toE164(cd.data().phone);
          if (!cph) continue;
          db.doc(`whatsappPendingScores/${cph}`).update({ [`fixtures.${cfId}`]: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
      } else {
        pendingRef.update({ [`fixtures.${cfId}`]: admin.firestore.FieldValue.delete() }).catch(() => {});
      }

      console.log(`[WhatsApp] Score confirmed: ${cfHome} ${pendingHome}-${pendingAway} ${cfAway}`);
      return twiml(cfMsg);
    } catch (err) {
      console.error('[WhatsApp] Confirm score failed:', err.message);
      return twiml(`❌ Could not confirm the score. Please use the app: ${APP_URL}`);
    }
  }

  // ── "Update Score" button — dispute a round, ask for corrected score ───
  if (isUpdateScore && hasConfirmPending) {
    const origSid = req.body && req.body.OriginalRepliedMessageSid
      ? String(req.body.OriginalRepliedMessageSid) : null;

    let updFix = null;
    if (origSid) {
      const e = Object.entries(fixturesMap).find(([, f]) => f.confirmMsgSid === origSid && f.awaitingConfirmation);
      if (e) updFix = { fixtureId: e[0], ...e[1] };
    }
    if (!updFix) {
      const e = Object.entries(fixturesMap).find(([, f]) => f.awaitingConfirmation);
      if (e) updFix = { fixtureId: e[0], ...e[1] };
    }
    if (!updFix) {
      return twiml(`❓ No score awaiting confirmation.\n🔗 ${APP_URL}`);
    }

    const updateCount = updFix.updateCount || 0;

    if (updateCount >= 2) {
      // Both teams have disputed twice — escalate to app
      const udTwilioSid   = TWILIO_SID.value();
      const udTwilioToken = TWILIO_TOKEN.value();
      const udTwilioFrom  = TWILIO_FROM.value();
      const udWClient     = twilio(udTwilioSid, udTwilioToken);

      const disputeMsg =
        `⚠️ Score dispute for ${updFix.homeTeam} vs ${updFix.awayTeam}` +
        (updFix.date ? ` on ${_fmtDate(updFix.date)}` : '') + `.\n\n` +
        `Both teams have submitted conflicting scores. Please resolve this in the app:\n🔗 ${APP_URL}`;

      // Notify submitting team
      if (updFix.submittedBySchoolId) {
        const ss = await db.collection('users').where('schoolId', '==', updFix.submittedBySchoolId).get();
        for (const sd of ss.docs) {
          const sph = _toE164(sd.data().phone);
          if (!sph) continue;
          udWClient.messages.create({ from: udTwilioFrom, to: `whatsapp:${sph}`, body: disputeMsg }).catch(() => {});
          db.doc(`whatsappPendingScores/${sph}`).update({ [`fixtures.${updFix.fixtureId}`]: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
      }
      // Clear confirming school
      const udConfSchool = user.schoolId;
      if (udConfSchool) {
        const cs = await db.collection('users').where('schoolId', '==', udConfSchool).get();
        for (const cd of cs.docs) {
          const cph = _toE164(cd.data().phone);
          if (!cph) continue;
          db.doc(`whatsappPendingScores/${cph}`).update({ [`fixtures.${updFix.fixtureId}`]: admin.firestore.FieldValue.delete() }).catch(() => {});
        }
      } else {
        pendingRef.update({ [`fixtures.${updFix.fixtureId}`]: admin.firestore.FieldValue.delete() }).catch(() => {});
      }
      // Flag fixture as disputed
      try {
        const udLRef = db.doc(`leagues/${updFix.leagueId}`);
        const udLDoc = await udLRef.get();
        if (udLDoc.exists) {
          const udFxArr = udLDoc.data().fixtures || [];
          const udFIdx  = udFxArr.findIndex(f => f.id === updFix.fixtureId);
          if (udFIdx !== -1) { udFxArr[udFIdx].scoreDisputed = true; await udLRef.update({ fixtures: udFxArr }); }
        }
      } catch (e) { console.warn('[WhatsApp] Could not flag dispute:', e.message); }

      console.log(`[WhatsApp] Score dispute: ${updFix.homeTeam} vs ${updFix.awayTeam}`);
      return twiml(disputeMsg);
    }

    // Allow the update — set awaitingScoreInput and track the pending update count
    await pendingRef.set({
      awaitingScoreInput: updFix.fixtureId,
      fixtures: {
        [updFix.fixtureId]: {
          ...fixturesMap[updFix.fixtureId],
          awaitingConfirmation: false,
          pendingUpdateCount: updateCount + 1,
        },
      },
    }, { merge: true });

    const udDateStr = updFix.date ? ` · ${_fmtDate(updFix.date)}` : '';
    return twiml(
      `✏️ *${updFix.homeTeam} vs ${updFix.awayTeam}${udDateStr}*\n\n` +
      `Reply with the correct score — *your score first*.\n\n` +
      `  If *${updFix.homeTeam}* won 6-3 → reply *6-3*\n` +
      `  If *${updFix.awayTeam}* won 6-3 → reply *3-6*`
    );
  }

  // ── Fallback: native WhatsApp "Reply" SID correlation ──────────────────
  // For users who long-press → Reply on a message rather than tapping the
  // button (e.g. plain-text fallback, or older app versions).
  const repliedSid     = req.body && req.body.OriginalRepliedMessageSid
    ? String(req.body.OriginalRepliedMessageSid)
    : null;
  const repliedEntry   = repliedSid
    ? Object.entries(fixturesMap).find(([, f]) => f.msgSid === repliedSid)
    : null;
  const repliedFixture = repliedEntry
    ? { fixtureId: repliedEntry[0], ...repliedEntry[1] }
    : null;

  if (repliedFixture) {
    console.log(`[WhatsApp] Native reply to msgSid ${repliedSid} → fixture ${repliedFixture.fixtureId}`);
  }

  // ── No text body — nothing more to process (button already handled above) ──
  if (!rawBody) return res.status(200).end();

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
  // Last-resort fallback: user typed a plain new message with no button or
  // reply context and has multiple fixtures pending.
  const menuOrder = Array.isArray(pendingData.menuOrder) ? pendingData.menuOrder : [];
  const numMatch  = !repliedFixture && rawBody.match(/^(\d+)$/);

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
      `Now reply with the score, *${selFix.homeTeam}'s score first* (e.g. *6-3*).`
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

    // Determine which fixture to score — priority order:
    //  1. awaitingScoreInput — user tapped "Submit Score" button (clearest signal)
    //  2. repliedFixture — native WhatsApp Reply to a specific message
    //  3. Only one fixture pending — unambiguous
    //  4. User already selected from the menu
    //  5. Multiple pending, no selection — send numbered menu
    let target = null;

    if (
      pendingData.awaitingScoreInput &&
      fixturesMap[pendingData.awaitingScoreInput] &&
      activeFixtures.find(f => f.fixtureId === pendingData.awaitingScoreInput)
    ) {
      // User tapped the "Submit Score" button — we know exactly which fixture
      target = { fixtureId: pendingData.awaitingScoreInput, ...fixturesMap[pendingData.awaitingScoreInput] };
    } else if (repliedFixture && activeFixtures.find(f => f.fixtureId === repliedFixture.fixtureId)) {
      // User used WhatsApp's native Reply on a specific reminder message
      target = repliedFixture;
    } else if (activeFixtures.length === 1) {
      // Only one pending game — unambiguous
      target = activeFixtures[0];
    } else if (
      pendingData.selectedFixtureId &&
      fixturesMap[pendingData.selectedFixtureId] &&
      activeFixtures.find(f => f.fixtureId === pendingData.selectedFixtureId)
    ) {
      // User already picked from the menu
      target = { fixtureId: pendingData.selectedFixtureId, ...fixturesMap[pendingData.selectedFixtureId] };
    } else {
      // Multiple fixtures, no selection yet — send a numbered menu
      const order = activeFixtures.map(f => f.fixtureId);
      const lines = activeFixtures.map((f, i) =>
        `${i + 1}. ${f.homeTeam} vs ${f.awayTeam}${f.date ? ' · ' + _fmtDate(f.date) : ''}`
      );
      await pendingRef.set({ menuOrder: order, selectedFixtureId: null }, { merge: true });
      return twiml(
        `📋 You have ${activeFixtures.length} matches pending. Reply with the number of the match:\n\n` +
        lines.join('\n') +
        '\n\nThen reply with the score (e.g. *6-3*, your score first).'
      );
    }

    // Apply the score to the chosen fixture
    try {
      const { fixtureId, leagueId, homeTeam, awayTeam, homeSchoolId, awaySchoolId } = target;
      const leagueRef = db.doc(`leagues/${leagueId}`);
      const leagueDoc = await leagueRef.get();
      if (!leagueDoc.exists) throw new Error('League not found');

      const fixtures = leagueDoc.data().fixtures || [];
      const idx      = fixtures.findIndex(f => f.id === fixtureId);
      if (idx === -1) throw new Error('Fixture not found');

      // Determine if submitter is home or away team
      const submitterSchoolId = user.schoolId || null;
      const isHome = submitterSchoolId && submitterSchoolId === homeSchoolId;
      const isAway = submitterSchoolId && submitterSchoolId === awaySchoolId;

      // Twilio client for sending WhatsApp to other team
      const twilioSid   = TWILIO_SID.value();
      const twilioToken = TWILIO_TOKEN.value();
      const twilioFrom  = TWILIO_FROM.value();
      const wClient     = twilio(twilioSid, twilioToken);

      /** Send a plain WhatsApp message to all users of a given school */
      async function _notifySchool(schoolId, msg) {
        if (!schoolId || !twilioFrom) return;
        const snap = await db.collection('users').where('schoolId', '==', schoolId).get();
        for (const doc of snap.docs) {
          const ph  = doc.data().phone;
          const ph164 = _toE164(ph);
          if (ph164) {
            try {
              await wClient.messages.create({ from: twilioFrom, to: `whatsapp:${ph164}`, body: msg });
            } catch (e) {
              console.warn(`[WhatsApp] Could not notify ${ph164}:`, e.message);
            }
          }
        }
      }

      if (isHome || isAway) {
        const teamLabel     = isHome ? homeTeam : awayTeam;
        const otherTeam     = isHome ? awayTeam : homeTeam;
        const otherSchoolId = isHome ? awaySchoolId : homeSchoolId;

        // Save score immediately (preliminary — opposing team still needs to confirm)
        fixtures[idx].homeScore          = homeScore;
        fixtures[idx].awayScore          = awayScore;
        fixtures[idx].homeTeamVerified   = false;
        fixtures[idx].awayTeamVerified   = false;
        fixtures[idx].homeTeamSubmission = null;
        fixtures[idx].awayTeamSubmission = null;
        fixtures[idx].scoreDisputed      = false;
        await leagueRef.update({ fixtures });

        // updateCount tracks how many "Update Score" rounds have happened
        const updateCount   = fixturesMap[fixtureId]?.pendingUpdateCount || 0;
        const scoreStr      = `${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`;
        const tmplVars      = {
          '1': teamLabel,
          '2': `${homeTeam} vs ${awayTeam}${target.date ? ' on ' + _fmtDate(target.date) : ''}`,
          '3': scoreStr,
        };
        const fixtureBase  = { leagueId, homeTeam, awayTeam, date: target.date, homeSchoolId, awaySchoolId };
        const expiresAt    = new Date(Date.now() + 48 * 60 * 60 * 1000);

        // Send score_confirmation template to every user of the opposing school
        const confSnap = await db.collection('users').where('schoolId', '==', otherSchoolId).get();
        for (const confDoc of confSnap.docs) {
          const cPh = _toE164(confDoc.data().phone);
          if (!cPh) continue;

          let confMsgSid = null;
          const confSid  = TEMPLATE_SIDS.score_confirmation;
          if (confSid && !confSid.startsWith('HX_FILL')) {
            try {
              const cMsg = await wClient.messages.create({
                from: twilioFrom, to: `whatsapp:${cPh}`,
                contentSid: confSid,
                contentVariables: JSON.stringify(tmplVars),
              });
              confMsgSid = cMsg.sid;
              console.log(`[WhatsApp] Confirmation template sent to ${cPh} — SID: ${confMsgSid}`);
            } catch (tErr) {
              console.warn(`[WhatsApp] Confirmation template failed for ${cPh}: ${tErr.message} — plain text`);
            }
          }
          if (!confMsgSid) {
            // Plain-text fallback (used before template is approved)
            try {
              const fallback =
                `${teamLabel} submitted the score for ${homeTeam} vs ${awayTeam}` +
                (target.date ? ` on ${_fmtDate(target.date)}` : '') + `:\n\n` +
                `🎾 ${scoreStr}\n\n` +
                `Is this correct? Reply *correct* to confirm, or *update score* to submit your own score.`;
              const cMsg = await wClient.messages.create({ from: twilioFrom, to: `whatsapp:${cPh}`, body: fallback });
              confMsgSid = cMsg.sid;
            } catch (e2) {
              console.warn(`[WhatsApp] Confirmation fallback failed for ${cPh}: ${e2.message}`);
              continue;
            }
          }

          await db.doc(`whatsappPendingScores/${cPh}`).set({
            fixtures: {
              [fixtureId]: {
                ...fixtureBase,
                awaitingConfirmation: true,
                confirmMsgSid,
                pendingHome: homeScore,
                pendingAway: awayScore,
                submittedBySchoolId: submitterSchoolId,
                updateCount,
                expiresAt,
              },
            },
          }, { merge: true });
        }

        await db.collection('auditLog').add({
          action: 'score_submitted', category: 'fixture',
          details: `WhatsApp score by ${isHome ? 'home' : 'away'}: ${homeTeam} ${homeScore}-${awayScore} ${awayTeam}`,
          itemId: fixtureId, itemName: `${homeTeam} vs ${awayTeam}`,
          at: new Date().toISOString(), by: user.uid, byName: user.displayName || fromPhone,
        });

        await pendingRef.update({
          [`fixtures.${fixtureId}`]: admin.firestore.FieldValue.delete(),
          menuOrder:          admin.firestore.FieldValue.delete(),
          selectedFixtureId:  admin.firestore.FieldValue.delete(),
          awaitingScoreInput: admin.firestore.FieldValue.delete(),
        });

        const remainingFix = activeFixtures.filter(f => f.fixtureId !== fixtureId);
        const followUp = remainingFix.length > 0
          ? `\n\n⏳ You still have ${remainingFix.length} more match${remainingFix.length > 1 ? 'es' : ''} awaiting a score.`
          : '';

        console.log(`[WhatsApp] Score submitted by ${isHome ? 'home' : 'away'}: ${homeTeam} ${homeScore}-${awayScore} ${awayTeam}`);
        return twiml(
          `✅ Score submitted!\n\n${homeTeam}  ${homeScore}  –  ${awayScore}  ${awayTeam}\n\n` +
          `${otherTeam} will be asked to confirm the result.${followUp}`
        );
      } else {
        // Submitter's school is not part of this match (admin/organiser contact) — save directly
        const prev = fixtures[idx].homeScore != null
          ? ` (overwrites previous ${fixtures[idx].homeScore}-${fixtures[idx].awayScore})`
          : '';
        fixtures[idx].homeScore = homeScore;
        fixtures[idx].awayScore = awayScore;
        await leagueRef.update({ fixtures });

        await db.collection('auditLog').add({
          action: 'score_submitted', category: 'fixture',
          details: `WhatsApp score (admin): ${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}${prev}`,
          itemId: fixtureId, itemName: `${homeTeam} vs ${awayTeam}`,
          at: new Date().toISOString(), by: user.uid, byName: user.displayName || fromPhone,
        });

        await pendingRef.update({
          [`fixtures.${fixtureId}`]: admin.firestore.FieldValue.delete(),
          menuOrder:          admin.firestore.FieldValue.delete(),
          selectedFixtureId:  admin.firestore.FieldValue.delete(),
          awaitingScoreInput: admin.firestore.FieldValue.delete(),
        });

        const remainingFix = activeFixtures.filter(f => f.fixtureId !== fixtureId);
        const followUp = remainingFix.length > 0
          ? `\n\n⏳ You still have ${remainingFix.length} more match${remainingFix.length > 1 ? 'es' : ''} awaiting a score.`
          : '';

        console.log(`[WhatsApp] Score saved (admin) ${homeTeam} ${homeScore}-${awayScore} ${awayTeam} by ${fromPhone}`);
        return twiml(
          `✅ Score received and saved!\n\n${homeTeam}  ${homeScore}  –  ${awayScore}  ${awayTeam}${prev}${followUp}\n\nNeed to correct it? Log in to the app:\n🔗 ${APP_URL}`
        );
      }
    } catch (err) {
      console.error('[WhatsApp] Score update failed:', err.message);
      return twiml(`❌ Could not save the score. Please enter it in the app: ${APP_URL}`);
    }
  }

  // ── Unrecognised message ─────────────────────────────────────────────────
  // Not a button tap, not a score, not a menu selection.
  // If the user has pending fixtures, guide them; otherwise ignore silently.
  console.log(`[WhatsApp] Unrecognised message from ${fromPhone}: ${JSON.stringify(rawBody)}`);
  if (activeFixtures.length > 0) {
    return twiml(
      `⚠️ Message not recognised.\n\n` +
      `To submit a score, tap the *Submit Score* button on the reminder, ` +
      `or reply with the result in this format: *6-3* (your score first).\n\n` +
      `To manage results in the app: 🔗 ${APP_URL}`
    );
  }
  return res.status(200).end();
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

// ── 4. Scheduled: daily score reminder at 17:00 SAST ─────────────────────────
// Fires at 17:00 Africa/Johannesburg every day.  Finds every unscored fixture
// whose date matches today (SAST) and sends one score_reminder notification to
// each school involved, exactly as the manual admin trigger does.
exports.dailyScoreReminder = onSchedule(
  {
    schedule: '0 17 * * *',
    timeZone: 'Africa/Johannesburg',
    secrets:  [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM],
  },
  async () => {
    const db = admin.firestore();

    // Today's date in SAST (the function runs in the correct timezone)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    console.log(`[ScoreReminder] Daily run for ${today}`);

    // Fetch all leagues
    const leaguesSnap = await db.collection('leagues').get();
    const notifications = [];

    leaguesSnap.forEach(leagueDoc => {
      const league = { id: leagueDoc.id, ...leagueDoc.data() };
      (league.fixtures || []).forEach(f => {
        if (!f.date || f.date !== today) return;
        if (f.homeScore != null || f.awayScore != null) return; // already scored
        if (!f.homeSchoolId || !f.awaySchoolId) return;
        notifications.push({ league, fixture: f });
      });
    });

    if (notifications.length === 0) {
      console.log('[ScoreReminder] No unscored fixtures today — nothing to send.');
      return;
    }

    // Fetch all users (to resolve school→uid mapping)
    const usersSnap = await db.collection('users').get();
    const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));

    const now = new Date().toISOString();

    let sent = 0;
    for (const { league, fixture: f } of notifications) {
      const schoolIds = [f.homeSchoolId, f.awaySchoolId];

      // Find uids for both schools (by schoolId or as organizer)
      const recipientUids = [...new Set(
        users
          .filter(u => schoolIds.includes(u.schoolId))
          .map(u => u.uid)
      )];

      if (recipientUids.length === 0) {
        console.log(`[ScoreReminder] No users for fixture ${f.id} — skipping`);
        continue;
      }

      const title = 'Please submit match result';
      const body  = `${f.homeSchoolName || 'Home'} vs ${f.awaySchoolName || 'Away'} on ${today} — please submit the match score.`;

      const batch = db.batch();
      for (const uid of recipientUids) {
        const ref = db.collection('notifications').doc();
        batch.set(ref, {
          uid,
          type:         'score_reminder',
          title,
          body,
          leagueId:     league.id,
          fixtureId:    f.id,
          homeTeam:     f.homeSchoolName  || '',
          awayTeam:     f.awaySchoolName  || '',
          date:         f.date,
          homeSchoolId: f.homeSchoolId,
          awaySchoolId: f.awaySchoolId,
          read:         false,
          createdAt:    now,
          createdBy:    null,
          fromName:     'Court Campus',
        });
      }
      await batch.commit();
      sent += recipientUids.length;
      console.log(`[ScoreReminder] Sent for fixture ${f.id} (${f.homeSchoolName} vs ${f.awaySchoolName}) to ${recipientUids.length} users`);
    }

    console.log(`[ScoreReminder] Done — ${sent} notifications written for ${notifications.length} fixtures`);
  }
);
