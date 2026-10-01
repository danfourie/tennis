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
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
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
    match_reminder:              '🎾',
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
      if (notif.opponent) {
        // Specific fixture change — use the fixture_changed template with opponent + date
        vars['1'] = notif.opponent;
        vars['2'] = notif.date || '';
      } else {
        // League-wide "fixtures updated" — no opponent/date, use general_message template
        // so the message is delivered with title+body instead of sending blank variables.
        vars['1'] = notif.title || '';
        vars['2'] = notif.body  || '';
        return { contentSid: TEMPLATE_SIDS.general_message, contentVariables: JSON.stringify(vars) };
      }
      break;
    case 'general_message':
    case 'league_created':
    case 'league_start_reminder':
      vars['1'] = notif.title      || '';
      vars['2'] = notif.body       || '';
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
    case 'match_reminder':
      // Reuse the general_message template ({{1}} title, {{2}} body)
      vars['1'] = notif.title || 'Match Reminder 🎾';
      vars['2'] = notif.body  || '';
      return { contentSid: TEMPLATE_SIDS.general_message, contentVariables: JSON.stringify(vars) };
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

    // General admin notifications are email-only — not WhatsApp
    if (notif.type === 'general_message') return null;

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

// ── 4. Outbound: admin sends a bulk notification email to registered users ─────
exports.sendBulkEmail = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    if (!request.auth) throw new Error('Unauthenticated');

    const callerDoc = await admin.firestore().doc(`users/${request.auth.uid}`).get();
    const caller    = callerDoc.exists ? callerDoc.data() : null;
    if (!caller || !['master', 'admin'].includes(caller.role)) {
      throw new Error('Permission denied — admins only');
    }

    const { recipientUids, subject, body } = request.data || {};
    if (!Array.isArray(recipientUids) || recipientUids.length === 0) throw new Error('recipientUids is required');
    if (!subject) throw new Error('subject is required');
    if (!body)    throw new Error('body is required');

    const emailUser = EMAIL_USER.value();
    const emailPass = EMAIL_PASS.value();
    if (!emailUser || !emailPass) throw new Error('Email credentials not configured — set EMAIL_USER and EMAIL_PASS secrets');

    // Fetch recipient emails from Firestore (Firestore 'in' operator max 10 per query)
    const recipientEmails = [];
    const chunks = [];
    for (let i = 0; i < recipientUids.length; i += 10) chunks.push(recipientUids.slice(i, i + 10));
    for (const chunk of chunks) {
      const snap = await admin.firestore().collection('users').where('uid', 'in', chunk).get();
      snap.forEach(doc => {
        const data = doc.data();
        if (data.email) recipientEmails.push({ email: data.email, name: data.displayName || '' });
      });
    }

    if (recipientEmails.length === 0) return { sent: 0, total: recipientUids.length };

    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });

    // Build HTML email — body newlines rendered as <br>
    const htmlBody = `
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
      <p>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
      <div class="cta"><a href="${APP_URL}">Open Court Campus →</a></div>
    </div>
    <div class="footer">
      Court Campus · <a href="${APP_URL}" style="color:#94a3b8">${APP_URL}</a>
    </div>
  </div>
</body>
</html>`;

    let sent = 0;
    for (const { email } of recipientEmails) {
      try {
        await transporter.sendMail({
          from:    `"Court Campus" <${emailUser}>`,
          to:      email,
          subject,
          text:    `${body}\n\n${APP_URL}`,
          html:    htmlBody,
        });
        sent++;
        console.log(`[BulkEmail] Sent to ${email}`);
      } catch (err) {
        console.error(`[BulkEmail] Failed for ${email}:`, err.message);
      }
    }

    console.log(`[BulkEmail] Done — ${sent}/${recipientEmails.length} sent for subject: "${subject}"`);
    return { sent, total: recipientEmails.length };
  }
);

// ── 5. Inbound: Twilio webhook — user replied on WhatsApp ─────────────────────
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
                confirmMsgSid: confMsgSid,
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

// ── 5. Scheduled: day-before match reminder at 17:00 SAST ────────────────────
// Fires at 17:00 Africa/Johannesburg every day.  Finds every unscored, non-skipped
// fixture scheduled for TOMORROW and sends a reminder to both teams via the
// channels configured in settings.matchReminderChannels ('both'|'whatsapp'|'email').
// Disabled when settings.matchReminderEnabled !== true.
exports.dailyMatchReminder = onSchedule(
  {
    schedule: '0 11 * * *',
    timeZone: 'Africa/Johannesburg',
    secrets:  [EMAIL_USER, EMAIL_PASS],  // WhatsApp delivered via notif-doc → onNewNotification
  },
  async () => {
    const db = admin.firestore();

    // Check global enable flag (default OFF — admin must opt in)
    const settingsDoc = await db.doc('settings/global').get();
    const settings = settingsDoc.exists ? settingsDoc.data() : {};
    if (!settings.matchReminderEnabled) {
      console.log('[MatchReminder] Disabled by global setting — skipping');
      return;
    }

    const channels    = settings.matchReminderChannels || 'both';
    const sendWA      = channels !== 'email';
    const sendEmail   = channels !== 'whatsapp';

    // Compute tomorrow's date in SAST
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const tomorrowObj  = new Date(ty, tm - 1, td + 1);
    const tomorrow     = `${tomorrowObj.getFullYear()}-${String(tomorrowObj.getMonth()+1).padStart(2,'0')}-${String(tomorrowObj.getDate()).padStart(2,'0')}`;
    console.log(`[MatchReminder] Running for tomorrow: ${tomorrow} | channels: ${channels}`);

    // Fetch all non-deleted leagues
    const leaguesSnap = await db.collection('leagues').get();
    const upcoming = [];
    leaguesSnap.forEach(doc => {
      const league = { id: doc.id, ...doc.data() };
      if (league.deleted) return;

      // Build participantId → schoolId map as fallback for older fixtures
      const partSchoolMap = {};
      if (league.participants && league.participants.length > 0) {
        league.participants.forEach(p => { if (p.participantId && p.schoolId) partSchoolMap[p.participantId] = p.schoolId; });
      } else {
        (league.schoolIds || []).forEach(id => { partSchoolMap[id] = id; });
      }

      (league.fixtures || []).forEach(f => {
        if (!f.date || f.date !== tomorrow)              return;
        if (f.reminderSkipped)                           return;
        if (f.homeScore != null || f.awayScore != null)  return;
        const hId = f.homeSchoolId || partSchoolMap[f.homeParticipantId];
        const aId = f.awaySchoolId || partSchoolMap[f.awayParticipantId];
        if (!hId || !aId)                                return;
        upcoming.push({ league, fixture: { ...f, homeSchoolId: hId, awaySchoolId: aId } });
      });
    });

    if (upcoming.length === 0) {
      console.log('[MatchReminder] No fixtures tomorrow — nothing to send.');
      return;
    }

    // Fetch users and schools once
    const [usersSnap, schoolsSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('schools').get(),
    ]);
    const users   = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    const schools = {};
    schoolsSnap.forEach(d => { schools[d.id] = d.data(); });

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function friendlyDate(iso) {
      if (!iso) return 'tomorrow';
      const [, m, d] = iso.split('-');
      return `${parseInt(d)} ${months[parseInt(m)-1]}`;
    }

    const nowISO  = new Date().toISOString();
    let waCount   = 0;
    let mailCount = 0;

    for (const { league, fixture: f } of upcoming) {
      const schoolIds     = [f.homeSchoolId, f.awaySchoolId];
      const homeSchoolName = f.homeSchoolName || (schools[f.homeSchoolId] && schools[f.homeSchoolId].name) || 'Home';
      const awaySchoolName = f.awaySchoolName || (schools[f.awaySchoolId] && schools[f.awaySchoolId].name) || 'Away';
      const fd        = friendlyDate(f.date);
      const title     = 'Match Reminder 🎾';
      const body      = `${homeSchoolName} vs ${awaySchoolName} — tomorrow (${fd})${f.timeSlot ? ' at ' + f.timeSlot : ''}${f.venueName ? ' at ' + f.venueName : ''}. Good luck!`;

      // ── WhatsApp: write notification docs → onNewNotification fires ──
      if (sendWA) {
        const recipientUids = [...new Set(
          users.filter(u => schoolIds.includes(u.schoolId)).map(u => u.uid)
        )];
        if (recipientUids.length > 0) {
          const batch = db.batch();
          for (const uid of recipientUids) {
            batch.set(db.collection('notifications').doc(), {
              uid,
              type:           'match_reminder',
              title,
              body,
              leagueId:       league.id,
              leagueName:     league.name || '',
              fixtureId:      f.id,
              homeSchoolName: homeSchoolName,
              awaySchoolName: awaySchoolName,
              date:           f.date,
              timeSlot:       f.timeSlot || '',
              venueName:      f.venueName || '',
              read:           false,
              createdAt:      nowISO,
              createdBy:      null,
              fromName:       'Court Campus',
            });
          }
          await batch.commit();
          waCount += recipientUids.length;
          console.log(`[MatchReminder] WA queued for ${homeSchoolName} vs ${awaySchoolName} — ${recipientUids.length} users`);
        }
      }

      // ── Email: send to registered users + school organizer contacts ──
      if (sendEmail) {
        const emailUser = EMAIL_USER.value();
        const emailPass = EMAIL_PASS.value();
        if (!emailUser || !emailPass) {
          console.warn('[MatchReminder] Email credentials not set — skipping email');
        } else {
          const emailSet = new Set();
          users.filter(u => schoolIds.includes(u.schoolId) && u.email).forEach(u => emailSet.add(u.email));
          for (const sid of schoolIds) {
            const sc = schools[sid];
            if (!sc) continue;
            (sc.organizers || []).forEach(o => { if (o.email) emailSet.add(o.email); });
            if (sc.email) emailSet.add(sc.email);
          }

          if (emailSet.size > 0) {
            const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });
            const subject = `Match Reminder: ${homeSchoolName} vs ${awaySchoolName} — Tomorrow (${fd})`;
            const textBody = `${body}\n\nView your fixtures: ${APP_URL}`;
            const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;background:#f4f7fb;margin:0;padding:0}
.container{max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.header{background:#3b82f6;padding:28px 32px;text-align:center}
.header h1{color:#fff;margin:0;font-size:22px}
.header p{color:#dbeafe;margin:6px 0 0;font-size:14px}
.body{padding:28px 32px;color:#1e293b;line-height:1.6}
.card{background:#f0f9ff;border-left:4px solid #3b82f6;border-radius:4px;padding:16px 20px;margin:16px 0}
.card .teams{font-size:18px;font-weight:700;color:#1e293b;margin-bottom:8px}
.card .detail{color:#475569;font-size:13px;margin:3px 0}
.cta{display:block;margin:24px 0;text-align:center}
.cta a{background:#3b82f6;color:#fff!important;text-decoration:none;padding:13px 32px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block}
.footer{text-align:center;padding:16px 32px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0}
</style></head><body>
<div class="container">
<div class="header"><h1>🎾 Court Campus</h1><p>Match Reminder</p></div>
<div class="body">
  <p>This is a reminder that your team has a match <strong>tomorrow</strong>.</p>
  <div class="card">
    <div class="teams">${homeSchoolName} vs ${awaySchoolName}</div>
    ${f.date    ? `<div class="detail">📅 Date: ${fd} (tomorrow)</div>` : ''}
    ${f.timeSlot ? `<div class="detail">⏰ Time: ${f.timeSlot}</div>` : ''}
    ${f.venueName ? `<div class="detail">📍 Venue: ${f.venueName}</div>` : ''}
    ${league.name ? `<div class="detail">🏆 League: ${league.name}</div>` : ''}
  </div>
  <div class="cta"><a href="${APP_URL}">View Fixtures on Court Campus →</a></div>
</div>
<div class="footer">Court Campus · <a href="${APP_URL}" style="color:#94a3b8">${APP_URL}</a></div>
</div></body></html>`;

            for (const email of emailSet) {
              try {
                await transporter.sendMail({
                  from:    `"Court Campus" <${emailUser}>`,
                  to:      email,
                  subject,
                  text:    textBody,
                  html:    htmlBody,
                });
                mailCount++;
              } catch (err) {
                console.error(`[MatchReminder] Email failed → ${email}:`, err.message);
              }
            }
            console.log(`[MatchReminder] Email sent for ${homeSchoolName} vs ${awaySchoolName} — ${emailSet.size} addresses`);
          }
        }
      }
    }

    console.log(`[MatchReminder] Done — ${waCount} WA notifications, ${mailCount} emails for ${upcoming.length} fixtures`);
  }
);

// ── 6. onCall: send admin general-message as email blast ─────────────────────
// Called from the admin "Send Notifications" panel.  Resolves target emails
// using the same school/organizer logic as the client-side notification helpers.
exports.sendGeneralEmail = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    const { title, body, groupType, groupId } = request.data || {};
    if (!title || !body) throw new HttpsError('invalid-argument', 'title and body are required');

    const db = admin.firestore();
    const [usersSnap, schoolsSnap, leaguesSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('schools').get(),
      db.collection('leagues').get(),
    ]);

    const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    const schools = {};
    schoolsSnap.forEach(d => { schools[d.id] = d.data(); });
    const leagues = {};
    leaguesSnap.forEach(d => { leagues[d.id] = d.data(); });

    // Resolve which school IDs are targeted
    let targetSchoolIds = null; // null = all users
    if (groupType === 'school' && groupId) {
      targetSchoolIds = new Set([groupId]);
    } else if (groupType === 'league' && groupId) {
      const league = leagues[groupId];
      targetSchoolIds = new Set();
      if (league) {
        (league.participants || []).forEach(p => { if (p.schoolId) targetSchoolIds.add(p.schoolId); });
        // fallback: schoolIds array on older leagues
        (league.schoolIds || []).forEach(id => targetSchoolIds.add(id));
      }
    }

    // Build normalised phone helper (mirrors client _normPhone)
    const normPhone = (p = '') => p.replace(/\D/g, '').replace(/^0/, '27');

    const emailSet = new Set();
    users.forEach(u => {
      if (!u.email) return;
      if (targetSchoolIds === null) {
        emailSet.add(u.email);
        return;
      }
      // Primary: user's schoolId
      if (u.schoolId && targetSchoolIds.has(u.schoolId)) {
        emailSet.add(u.email);
        return;
      }
      // Secondary: user is an organizer of a targeted school
      for (const sid of targetSchoolIds) {
        const school = schools[sid];
        if (!school) continue;
        for (const org of (school.organizers || [])) {
          if ((org.email && org.email.toLowerCase() === u.email.toLowerCase()) ||
              (org.phone && u.phone && normPhone(org.phone) === normPhone(u.phone))) {
            emailSet.add(u.email);
            return;
          }
        }
      }
    });

    if (emailSet.size === 0) {
      console.log('[GeneralEmail] No recipient emails found — nothing sent');
      return { sent: 0 };
    }

    const emailUser = process.env[EMAIL_USER.name];
    const emailPass = process.env[EMAIL_PASS.name];
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass },
    });

    const APP_URL = 'https://courtcampus.co.za';
    const escapedBody = body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif}
.container{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.header{background:#1e3a5f;padding:24px 32px;text-align:center}
.header h1{color:#fff;margin:0;font-size:22px}
.header p{color:#93c5fd;margin:4px 0 0;font-size:13px}
.body{padding:28px 32px;color:#334155;line-height:1.6}
.message{background:#f8fafc;border-left:4px solid #3b82f6;border-radius:6px;padding:16px 20px;margin:16px 0;white-space:pre-wrap;font-size:15px}
.footer{text-align:center;padding:16px 32px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0}
</style></head><body>
<div class="container">
<div class="header"><h1>🎾 Court Campus</h1><p>Notification from your administrator</p></div>
<div class="body">
  <p><strong>${escapedBody.split('<br>')[0] === title ? '' : title}</strong></p>
  <div class="message">${escapedBody}</div>
  <p style="margin-top:20px;font-size:13px;color:#64748b">Log in to Court Campus to view all notifications.</p>
</div>
<div class="footer">Court Campus · <a href="${APP_URL}" style="color:#94a3b8">${APP_URL}</a></div>
</div></body></html>`;

    let sent = 0;
    for (const email of emailSet) {
      try {
        await transporter.sendMail({
          from:    `"Court Campus" <${emailUser}>`,
          to:      email,
          subject: title,
          text:    `${title}\n\n${body}\n\n${APP_URL}`,
          html:    htmlBody,
        });
        sent++;
      } catch (err) {
        console.error(`[GeneralEmail] Failed → ${email}:`, err.message);
      }
    }

    console.log(`[GeneralEmail] Done — ${sent}/${emailSet.size} emails sent for "${title}"`);
    return { sent };
  }
);

// ── 7. onCall: send branded password-reset email ──────────────────────────────
// Replaces Firebase's built-in reset email (which uses the project ID as the
// app name) with a fully branded "Court Campus" email.
// Returns { ok: true } for both valid and unknown emails (don't reveal existence).
exports.sendPasswordReset = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    const { email } = request.data || {};
    if (!email || typeof email !== 'string') throw new HttpsError('invalid-argument', 'email is required');

    const APP_URL = 'https://courtcampus.co.za';

    // Generate the Firebase-signed reset link (oobCode handled by our app)
    let resetLink;
    try {
      resetLink = await admin.auth().generatePasswordResetLink(email.trim(), {
        url:            APP_URL,
        handleCodeInApp: true,
      });
    } catch (err) {
      // auth/user-not-found — don't reveal; just return ok silently
      if (err.code === 'auth/user-not-found') {
        console.log(`[PasswordReset] Unknown email (not revealed to caller): ${email}`);
        return { ok: true };
      }
      console.error('[PasswordReset] generatePasswordResetLink failed:', err.message);
      throw new HttpsError('internal', 'Could not generate reset link');
    }

    const emailUser = process.env[EMAIL_USER.name];
    const emailPass = process.env[EMAIL_PASS.name];
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass },
    });

    const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif}
.container{max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.header{background:#1e3a5f;padding:24px 32px;text-align:center}
.header h1{color:#fff;margin:0;font-size:22px}
.header p{color:#93c5fd;margin:4px 0 0;font-size:13px}
.body{padding:28px 32px;color:#334155;line-height:1.6;font-size:15px}
.cta{display:block;margin:24px 0;text-align:center}
.cta a{background:#3b82f6;color:#fff!important;text-decoration:none;padding:13px 32px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block}
.hint{font-size:12px;color:#94a3b8;margin-top:4px}
.footer{text-align:center;padding:16px 32px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0}
</style></head><body>
<div class="container">
<div class="header"><h1>🎾 Court Campus</h1><p>Password Reset</p></div>
<div class="body">
  <p>Hello,</p>
  <p>We received a request to reset your Court Campus password for <strong>${email}</strong>.</p>
  <p>Click the button below to choose a new password:</p>
  <div class="cta">
    <a href="${resetLink}">Reset my password</a>
    <p class="hint">This link expires in 1 hour.</p>
  </div>
  <p>If the button doesn't work, copy and paste this link into your browser:</p>
  <p style="word-break:break-all;font-size:12px;color:#64748b">${resetLink}</p>
  <p style="margin-top:1.5rem;font-size:13px;color:#64748b">If you didn't request a password reset, you can safely ignore this email — your password will not change.</p>
</div>
<div class="footer">Court Campus · <a href="${APP_URL}" style="color:#94a3b8">${APP_URL}</a></div>
</div></body></html>`;

    const textBody = `Reset your Court Campus password\n\nHello,\n\nWe received a request to reset your Court Campus password for ${email}.\n\nClick the link below to choose a new password (expires in 1 hour):\n${resetLink}\n\nIf you didn't request a password reset, you can safely ignore this email.\n\nCourt Campus\n${APP_URL}`;

    try {
      await transporter.sendMail({
        from:    `"Court Campus" <${emailUser}>`,
        to:      email.trim(),
        subject: 'Reset your password for Court Campus',
        text:    textBody,
        html:    htmlBody,
      });
      console.log(`[PasswordReset] Email sent to ${email}`);
    } catch (err) {
      console.error('[PasswordReset] sendMail failed:', err.message);
      throw new HttpsError('internal', 'Could not send reset email');
    }

    return { ok: true };
  }
);

// ── 8. Booking notification emails ────────────────────────────────────────────
// Notifies venue organizers when a new pending booking arrives,
// and notifies the requester when their booking is approved or rejected.

/**
 * Called from CourtBooking.js after a pending request is submitted.
 * Looks up venue organizers and emails them about the new request.
 */
// ── HTML email helpers for booking notifications ──────────────────────────────
function _h(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _bookingEmailHtml({ headerBg, headerLabel, bodyHtml }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:Arial,sans-serif;background:#f4f7fb;margin:0;padding:0}
    .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    .hdr{background:${headerBg};padding:28px 32px;text-align:center}
    .logo{color:#fff;margin:0;font-size:24px;font-weight:700;letter-spacing:-.5px}
    .sub{color:rgba(255,255,255,.85);margin:6px 0 0;font-size:14px}
    .bdy{padding:28px 32px;color:#1e293b;line-height:1.6;font-size:15px}
    .bdy p{margin:0 0 14px}
    .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;margin:16px 0}
    .box table{width:100%;border-collapse:collapse;font-size:14px}
    .box td{padding:5px 0;vertical-align:top}
    .box td:first-child{color:#64748b;width:120px;white-space:nowrap}
    .box td:last-child{color:#0f172a;font-weight:500}
    .stbl{width:100%;font-size:13px;border-collapse:collapse;margin:12px 0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}
    .stbl th,.stbl td{padding:7px 10px;text-align:left}
    .stbl th{background:#f1f5f9;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
    .stbl tr+tr td{border-top:1px solid #e2e8f0}
    .cta{text-align:center;margin:24px 0}
    .cta a{background:${headerBg};color:#fff!important;text-decoration:none;padding:13px 32px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block}
    .ftr{text-align:center;padding:16px 32px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <div class="logo">🎾 Court Campus</div>
      <div class="sub">${_h(headerLabel)}</div>
    </div>
    <div class="bdy">
      ${bodyHtml}
      <div class="cta"><a href="${APP_URL}">Open Court Campus &rarr;</a></div>
    </div>
    <div class="ftr">
      Court Campus &middot; <a href="${APP_URL}" style="color:#94a3b8">${APP_URL}</a><br>
      You received this automated notification from Court Campus.
    </div>
  </div>
</body>
</html>`;
}

exports.notifyBookingRequest = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    if (!request.auth) return { ok: false };
    const { bookingId, groupId } = request.data || {};
    if (!bookingId && !groupId) return { ok: false };

    const db = admin.firestore();
    let bookings = [];
    if (groupId) {
      const gSnap = await db.collection('bookings').where('groupId', '==', groupId).get();
      bookings = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (bookings.length === 0) return { ok: false };
    } else {
      const bSnap = await db.collection('bookings').doc(bookingId).get();
      if (!bSnap.exists) return { ok: false };
      bookings = [{ id: bSnap.id, ...bSnap.data() }];
    }
    const booking = bookings[0]; // representative for venue / organizer lookup

    // Find venue
    const vSnap  = await db.collection('venues').doc(booking.venueId || '').get();
    const vName  = vSnap.exists ? vSnap.data().name : 'Unknown venue';

    // Find organizer emails and UIDs: users whose school's venueId matches
    const schoolsSnap = await db.collection('schools').where('venueId', '==', booking.venueId).get();
    const orgEmails   = [];
    const orgUids     = [];
    for (const sDoc of schoolsSnap.docs) {
      const usersSnap = await db.collection('users').where('schoolId', '==', sDoc.id).get();
      for (const uDoc of usersSnap.docs) {
        const u = uDoc.data();
        if (['master', 'admin', 'organizer'].includes(u.role) && !u.noBookingRequests) {
          if (u.email) orgEmails.push(u.email);
          orgUids.push(uDoc.id);
        }
      }
    }
    // Also include all admins/masters (unless opted out of booking request notifications)
    const adminsSnap = await db.collection('users').where('role', 'in', ['master', 'admin']).get();
    adminsSnap.docs.forEach(d => {
      if (d.data().noBookingRequests) return;
      if (d.data().email) orgEmails.push(d.data().email);
      orgUids.push(d.id);
    });

    const recipients = [...new Set(orgEmails)];
    const notifUids  = [...new Set(orgUids)];

    // Write in-app notifications for each organizer
    if (notifUids.length > 0) {
      const now      = admin.firestore.FieldValue.serverTimestamp();
      const userName = booking.requestedByName || booking.bookerName || 'Someone';
      const slotLabel = booking.timeSlot === 'morning' ? 'Morning (07:00–14:00)' : booking.timeSlot === 'afternoon' ? 'Afternoon (14:00–18:00)' : (booking.timeSlot || '');
      const notifBody = bookings.length > 1
        ? `${userName} requested ${bookings.length} slots: ${bookings.map(b => `Court ${(b.courtIndex || 0) + 1} on ${b.date}`).join(', ')} (${booking.reason || booking.label || '—'})`
        : `${userName} requested ${slotLabel} on ${booking.date} (${booking.reason || booking.label || '—'})`;
      const nb = db.batch();
      for (const uid of notifUids) {
        nb.set(db.collection('notifications').doc(), {
          uid, type: 'booking_request',
          title:    `New booking request — ${vName}`,
          body:     notifBody,
          fromName: userName, bookingId: booking.id || bookingId || null,
          groupId:  groupId || null, read: false, createdAt: now, createdBy: booking.requestedBy || null,
        });
      }
      await nb.commit();
    }

    if (recipients.length === 0) return { ok: true, sent: 0 };

    const emailUser = EMAIL_USER.value();
    const emailPass = EMAIL_PASS.value();
    if (!emailUser || !emailPass) return { ok: false };

    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });

    const _slotStr = s => s === 'morning' ? 'Morning (07:00–14:00)' : s === 'afternoon' ? 'Afternoon (14:00–18:00)' : (s || '');
    const subject  = bookings.length > 1
      ? `New Court Booking Request (${bookings.length} slots) — ${vName}`
      : `New Court Booking Request — ${vName}`;
    const slotsSection = bookings.length === 1
      ? [
          `Date:  ${booking.date}`,
          `Court: Court ${(booking.courtIndex || 0) + 1}`,
          `Slot:  ${_slotStr(booking.timeSlot)}`,
        ]
      : [
          `Slots (${bookings.length}):`,
          ...bookings
            .slice()
            .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.courtIndex || 0) - (b.courtIndex || 0))
            .map((b, i) => `  ${i + 1}. ${b.date}  Court ${(b.courtIndex || 0) + 1}  ${_slotStr(b.timeSlot)}`),
        ];
    const text = [
      bookings.length > 1
        ? `A new court booking request has been submitted for ${bookings.length} slots.`
        : `A new court booking request has been submitted.`,
      ``,
      `Venue:  ${vName}`,
      ...slotsSection,
      `Reason: ${booking.reason || booking.label || '—'}`,
      `Booker: ${booking.bookerName || booking.requestedByName || '—'}`,
      booking.onBehalfName ? `On behalf of: ${booking.onBehalfName} (${booking.onBehalfContact || 'no contact'})` : '',
      ``,
      `Log in to Court Campus to approve or decline: ${APP_URL}`,
    ].filter(Boolean).join('\n');

    const sortedSlots = bookings
      .slice()
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.courtIndex || 0) - (b.courtIndex || 0));
    const detailsHtml = bookings.length === 1
      ? `<div class="box"><table>
          <tr><td>Venue</td><td>${_h(vName)}</td></tr>
          <tr><td>Date</td><td>${_h(booking.date)}</td></tr>
          <tr><td>Court</td><td>Court ${(booking.courtIndex || 0) + 1}</td></tr>
          <tr><td>Slot</td><td>${_h(_slotStr(booking.timeSlot))}</td></tr>
          <tr><td>Reason</td><td>${_h(booking.reason || booking.label || '—')}</td></tr>
          <tr><td>Booker</td><td>${_h(booking.bookerName || booking.requestedByName || '—')}</td></tr>
          ${booking.onBehalfName ? `<tr><td>On behalf of</td><td>${_h(booking.onBehalfName)}${booking.onBehalfContact ? ` (${_h(booking.onBehalfContact)})` : ''}</td></tr>` : ''}
        </table></div>`
      : `<div class="box"><table>
          <tr><td>Venue</td><td>${_h(vName)}</td></tr>
          <tr><td>Slots</td><td>${bookings.length}</td></tr>
          <tr><td>Reason</td><td>${_h(booking.reason || booking.label || '—')}</td></tr>
          <tr><td>Booker</td><td>${_h(booking.bookerName || booking.requestedByName || '—')}</td></tr>
        </table></div>
        <table class="stbl">
          <thead><tr><th>#</th><th>Date</th><th>Court</th><th>Slot</th></tr></thead>
          <tbody>${sortedSlots.map((b, i) => `<tr>
            <td>${i + 1}</td>
            <td>${_h(b.date)}</td>
            <td>Court ${(b.courtIndex || 0) + 1}</td>
            <td>${_h(_slotStr(b.timeSlot))}</td>
          </tr>`).join('')}</tbody>
        </table>`;
    const htmlEmail = _bookingEmailHtml({
      headerBg:    '#3b82f6',
      headerLabel: bookings.length > 1 ? `New Booking Request — ${bookings.length} Slots` : 'New Booking Request',
      bodyHtml: `<p>${bookings.length > 1
        ? `A new court booking request for <strong>${bookings.length} slots</strong> has been submitted at <strong>${_h(vName)}</strong>.`
        : `A new court booking request has been submitted at <strong>${_h(vName)}</strong>.`}</p>
        ${detailsHtml}
        <p style="font-size:13px;color:#64748b">Please log in to approve or decline this request.</p>`,
    });

    let sent = 0;
    for (const email of recipients) {
      try {
        await transporter.sendMail({ from: `"Court Campus" <${emailUser}>`, to: email, subject, text, html: htmlEmail });
        sent++;
      } catch (e) { console.error('[notifyBookingRequest] sendMail failed:', e.message); }
    }
    return { ok: true, sent };
  }
);

/**
 * Called when an admin/organizer approves or rejects a booking.
 * Emails the original requester.
 */
exports.notifyBookingStatus = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
    const { bookingId, action } = request.data || {};
    if (!bookingId || !['approved', 'rejected', 'cancelled'].includes(action)) throw new HttpsError('invalid-argument', 'bookingId and action required');

    const db         = admin.firestore();
    const callerSnap = await db.doc(`users/${request.auth.uid}`).get();
    const caller     = callerSnap.exists ? callerSnap.data() : null;
    if (!caller) throw new HttpsError('permission-denied', 'Unauthorized');

    const bSnap = await db.collection('bookings').doc(bookingId).get();
    if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found');
    const booking = bSnap.data();

    // Allow master/admin/organizer roles, or any user who organizes this venue
    const isGlobal = ['master', 'admin', 'organizer'].includes(caller.role);
    if (!isGlobal) {
      const sSnap = caller.schoolId ? await db.collection('schools').doc(caller.schoolId).get() : null;
      if (!sSnap || !sSnap.exists || sSnap.data().venueId !== booking.venueId) {
        throw new HttpsError('permission-denied', 'Not authorized for this venue');
      }
    }

    // Get requester email from users collection
    if (!booking.requestedBy) return { ok: true, sent: 0 };
    const uSnap = await db.collection('users').doc(booking.requestedBy).get();
    const reqEmail = uSnap.exists ? uSnap.data().email : null;
    if (!reqEmail) return { ok: true, sent: 0 };

    const vSnap = await db.collection('venues').doc(booking.venueId || '').get();
    const vName = vSnap.exists ? vSnap.data().name : 'Unknown venue';
    const slot  = booking.timeSlot === 'morning' ? 'Morning (07:00–14:00)' : booking.timeSlot === 'afternoon' ? 'Afternoon (14:00–18:00)' : (booking.timeSlot || '');

    const emailUser = EMAIL_USER.value();
    const emailPass = EMAIL_PASS.value();
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });

    const subject = action === 'approved'
      ? `Court Booking Approved — ${vName} ${booking.date}`
      : action === 'cancelled'
        ? `Court Booking Cancelled — ${vName} ${booking.date}`
        : `Court Booking Declined — ${vName} ${booking.date}`;
    const text = action === 'approved'
      ? [
          `Your court booking request has been approved! ✓`,
          ``,
          `Venue: ${vName}`,
          `Date:  ${booking.date}`,
          `Court: Court ${(booking.courtIndex || 0) + 1}`,
          `Slot:  ${slot}`,
          `Reason: ${booking.reason || booking.label || '—'}`,
          ``,
          `View your booking at: ${APP_URL}`,
        ].join('\n')
      : action === 'cancelled'
        ? [
            `Your confirmed court booking has been cancelled.`,
            ``,
            `Venue: ${vName}`,
            `Date:  ${booking.date}`,
            `Court: Court ${(booking.courtIndex || 0) + 1}`,
            `Slot:  ${slot}`,
            `Reason: ${booking.reason || booking.label || '—'}`,
            ``,
            `Please contact your venue organizer for more information or submit a new request at: ${APP_URL}`,
          ].join('\n')
        : [
            `Unfortunately, your court booking request has been declined.`,
            ``,
            `Venue: ${vName}`,
            `Date:  ${booking.date}`,
            `Court: Court ${(booking.courtIndex || 0) + 1}`,
            `Slot:  ${slot}`,
            `Reason: ${booking.reason || booking.label || '—'}`,
            ``,
            `Please contact your venue organizer for more information, or submit a new request at: ${APP_URL}`,
          ].join('\n');

    const detailsBox = `<div class="box"><table>
      <tr><td>Venue</td><td>${_h(vName)}</td></tr>
      <tr><td>Date</td><td>${_h(booking.date)}</td></tr>
      <tr><td>Court</td><td>Court ${(booking.courtIndex || 0) + 1}</td></tr>
      <tr><td>Slot</td><td>${_h(slot)}</td></tr>
      <tr><td>Reason</td><td>${_h(booking.reason || booking.label || '—')}</td></tr>
    </table></div>`;
    const htmlEmail = _bookingEmailHtml(
      action === 'approved' ? {
        headerBg:    '#16a34a',
        headerLabel: 'Booking Approved ✓',
        bodyHtml:    `<p>Great news — your court booking has been <strong>approved</strong>!</p>${detailsBox}<p style="font-size:13px;color:#64748b">See you on the court!</p>`,
      } : action === 'cancelled' ? {
        headerBg:    '#d97706',
        headerLabel: 'Booking Cancelled',
        bodyHtml:    `<p>Your confirmed court booking has been <strong>cancelled</strong> by the venue organizer.</p>${detailsBox}<p style="font-size:13px;color:#64748b">Please contact your venue organizer for more information, or submit a new request.</p>`,
      } : {
        headerBg:    '#dc2626',
        headerLabel: 'Booking Request Declined',
        bodyHtml:    `<p>Unfortunately your court booking request has been <strong>declined</strong>.</p>${detailsBox}<p style="font-size:13px;color:#64748b">Please contact your venue organizer for more information, or submit a new request.</p>`,
      }
    );
    try {
      await transporter.sendMail({ from: `"Court Campus" <${emailUser}>`, to: reqEmail, subject, text, html: htmlEmail });
    } catch (e) { console.error('[notifyBookingStatus] sendMail failed:', e.message); }
    return { ok: true };
  }
);

/**
 * Called by the booking requester when they cancel their own booking.
 * Notifies venue organizers via email + in-app notification.
 */
exports.notifyUserCancellation = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    if (!request.auth) return { ok: false };
    const { bookingId, groupId } = request.data || {};
    if (!bookingId) return { ok: false };

    const db = admin.firestore();

    // Load the representative booking for venue/organizer lookup
    const bSnap = await db.collection('bookings').doc(bookingId).get();
    // Booking may already be soft-deleted (status=cancelled) — still readable
    const booking = bSnap.exists ? { id: bSnap.id, ...bSnap.data() } : null;
    if (!booking) return { ok: false };

    // Only the original requester may call this
    if (booking.requestedBy !== request.auth.uid) return { ok: false };

    const vSnap = await db.collection('venues').doc(booking.venueId || '').get();
    const vName = vSnap.exists ? vSnap.data().name : 'Unknown venue';

    // Find organizer emails and UIDs (same logic as notifyBookingRequest)
    const schoolsSnap = await db.collection('schools').where('venueId', '==', booking.venueId).get();
    const orgEmails   = [];
    const orgUids     = [];
    for (const sDoc of schoolsSnap.docs) {
      const usersSnap = await db.collection('users').where('schoolId', '==', sDoc.id).get();
      for (const uDoc of usersSnap.docs) {
        const u = uDoc.data();
        if (['master', 'admin', 'organizer'].includes(u.role)) {
          if (u.email) orgEmails.push(u.email);
          orgUids.push(uDoc.id);
        }
      }
    }
    const adminsSnap = await db.collection('users').where('role', 'in', ['master', 'admin']).get();
    adminsSnap.docs.forEach(d => {
      if (d.data().email) orgEmails.push(d.data().email);
      orgUids.push(d.id);
    });

    const recipients = [...new Set(orgEmails)];
    const notifUids  = [...new Set(orgUids)];

    const cancellerName = booking.requestedByName || booking.bookerName || 'A user';
    const slot = booking.timeSlot === 'morning' ? 'Morning (07:00–14:00)' : booking.timeSlot === 'afternoon' ? 'Afternoon (14:00–18:00)' : (booking.timeSlot || '');

    // In-app notifications for organizers
    if (notifUids.length > 0) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const nb  = db.batch();
      for (const uid of notifUids) {
        nb.set(db.collection('notifications').doc(), {
          uid, type: 'booking_cancelled',
          title:    `Booking cancelled — ${vName}`,
          body:     `${cancellerName} cancelled their booking for Court ${(booking.courtIndex || 0) + 1} on ${booking.date} (${booking.reason || booking.label || '—'})`,
          read: false, createdAt: now, createdBy: request.auth.uid,
        });
      }
      await nb.commit();
    }

    if (recipients.length === 0) return { ok: true, sent: 0 };

    const emailUser = EMAIL_USER.value();
    const emailPass = EMAIL_PASS.value();
    if (!emailUser || !emailPass) return { ok: false };

    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });
    const subject = `Court Booking Cancelled — ${vName} ${booking.date}`;
    const text = [
      `A court booking has been cancelled by the requester.`,
      ``,
      `Venue:  ${vName}`,
      `Date:   ${booking.date}`,
      `Court:  Court ${(booking.courtIndex || 0) + 1}`,
      `Slot:   ${slot}`,
      `Reason: ${booking.reason || booking.label || '—'}`,
      `By:     ${cancellerName}`,
      ``,
      `Log in to Court Campus for details: ${APP_URL}`,
    ].join('\n');
    const htmlEmail = _bookingEmailHtml({
      headerBg:    '#d97706',
      headerLabel: 'Booking Cancelled by Requester',
      bodyHtml:    `<p>A court booking has been <strong>cancelled</strong> by the requester.</p>
        <div class="box"><table>
          <tr><td>Venue</td><td>${_h(vName)}</td></tr>
          <tr><td>Date</td><td>${_h(booking.date)}</td></tr>
          <tr><td>Court</td><td>Court ${(booking.courtIndex || 0) + 1}</td></tr>
          <tr><td>Slot</td><td>${_h(slot)}</td></tr>
          <tr><td>Reason</td><td>${_h(booking.reason || booking.label || '—')}</td></tr>
          <tr><td>Cancelled by</td><td>${_h(cancellerName)}</td></tr>
        </table></div>`,
    });

    let sent = 0;
    for (const email of recipients) {
      try {
        await transporter.sendMail({ from: `"Court Campus" <${emailUser}>`, to: email, subject, text, html: htmlEmail });
        sent++;
      } catch (e) { console.error('[notifyUserCancellation] sendMail failed:', e.message); }
    }
    return { ok: true, sent };
  }
);

// ── 9. Scheduled: clean up expired court closures ─────────────────────────────
// Removes closures whose endDate is more than 7 days in the past.
exports.cleanExpiredClosures = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Africa/Johannesburg' },
  async () => {
    const db      = admin.firestore();
    const cutoff  = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutStr  = cutoff.toISOString().slice(0, 10);
    const snap    = await db.collection('closures').where('endDate', '<', cutStr).get();
    if (snap.empty) { console.log('[cleanExpiredClosures] Nothing to delete'); return; }
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`[cleanExpiredClosures] Deleted ${snap.size} expired closures`);
  }
);

// ── 10. Public: Contact Admin form (callable by unauthenticated guests) ────────
// Writes an in-app notification for every admin/master user and sends them an email.
exports.contactAdmin = onCall(
  { invoker: 'public', secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    const { name, email, message } = request.data || {};
    if (!name    || typeof name    !== 'string' || !name.trim())    throw new HttpsError('invalid-argument', 'name is required');
    if (!message || typeof message !== 'string' || !message.trim()) throw new HttpsError('invalid-argument', 'message is required');

    const safeName    = name.trim();
    const safeEmail   = (email || '').trim();
    const safeMessage = message.trim();

    const db   = admin.firestore();
    const snap = await db.collection('users').where('role', 'in', ['admin', 'master']).get();
    if (snap.empty) return { ok: true };

    const now         = admin.firestore.FieldValue.serverTimestamp();
    const batch       = db.batch();
    const adminEmails = [];

    snap.docs.forEach(doc => {
      const u = doc.data();
      const notifRef = db.collection('notifications').doc();
      batch.set(notifRef, {
        uid:       doc.id,
        type:      'contact_request',
        title:     `Guest message from ${safeName}`,
        body:      safeMessage,
        fromName:  safeName,
        fromEmail: safeEmail,
        read:      false,
        createdAt: now,
      });
      if (u.email) adminEmails.push(u.email);
    });
    await batch.commit();
    console.log(`[contactAdmin] Notified ${snap.size} admin(s) of guest message from ${safeName}`);

    if (adminEmails.length > 0) {
      const emailUser = EMAIL_USER.value();
      const emailPass = EMAIL_PASS.value();
      if (emailUser && emailPass) {
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });
        const subject = `[Court Campus] Guest contact from ${safeName}`;
        const text = [
          `A visitor to courtcampus.co.za has sent a contact request.`,
          ``,
          `From:    ${safeName}${safeEmail ? ` <${safeEmail}>` : ''}`,
          ``,
          `Message:`,
          safeMessage,
          ``,
          `Log in to view your in-app notifications: ${APP_URL}`,
        ].join('\n');
        try {
          await transporter.sendMail({ from: `"Court Campus" <${emailUser}>`, to: adminEmails.join(', '), subject, text });
        } catch (e) { console.error('[contactAdmin] sendMail failed:', e.message); }
      }
    }
    return { ok: true };
  }
);

// ── 11. Public: Groenkloof court booking (unauthenticated guests) ─────────────
// Looks up or creates a user by email, writes the booking via Admin SDK (bypasses
// Firestore rules), and returns a custom auth token so the client can sign in.
exports.bookGroenkloofCourt = onCall(
  { invoker: 'public', secrets: [EMAIL_USER, EMAIL_PASS] },
  async (request) => {
    const { name, email, phone, password, venueId, courtIndex, date, timeSlot, bookingType, details } = request.data || {};

    if (!name    || !name.trim())           throw new HttpsError('invalid-argument', 'Full name is required');
    if (!email   || !email.trim())          throw new HttpsError('invalid-argument', 'Email address is required');
    if (!phone   || !phone.trim())          throw new HttpsError('invalid-argument', 'Contact number is required');
    if (!venueId)                           throw new HttpsError('invalid-argument', 'venueId is required');
    if (!date)                              throw new HttpsError('invalid-argument', 'date is required');
    if (!timeSlot)                          throw new HttpsError('invalid-argument', 'timeSlot is required');
    if (!bookingType || !bookingType.trim()) throw new HttpsError('invalid-argument', 'Booking type is required');

    const db        = admin.firestore();
    const authAdmin = admin.auth();
    let uid, userName, isNewUser = false;

    // Find existing account, or create one
    try {
      const existing = await authAdmin.getUserByEmail(email.trim());
      uid      = existing.uid;
      userName = existing.displayName || name.trim();
    } catch (_notFound) {
      // No existing account — password required to create one
      if (!password || password.length < 6) {
        throw new HttpsError('invalid-argument', 'A password of at least 6 characters is required to create your account');
      }
      const newUser = await authAdmin.createUser({ email: email.trim(), password, displayName: name.trim() });
      uid      = newUser.uid;
      userName = name.trim();
      isNewUser = true;
      await db.collection('users').doc(uid).set({
        displayName: name.trim(),
        email:       email.trim(),
        role:        'user',
        phone:       phone.trim(),
        createdAt:   new Date().toISOString(),
      });
    }

    // Check slot availability
    const clash = await db.collection('bookings')
      .where('venueId',    '==', venueId)
      .where('courtIndex', '==', courtIndex || 0)
      .where('date',       '==', date)
      .where('timeSlot',   '==', timeSlot)
      .get();
    if (!clash.empty && clash.docs.some(d => ['confirmed', 'pending'].includes(d.data().status))) {
      throw new HttpsError('already-exists', 'This slot is already booked — please choose a different time or court');
    }

    // Write booking via Admin SDK (bypasses Firestore security rules)
    const reason     = (bookingType + (details && details.trim() ? ': ' + details.trim() : '')).trim();
    const bookingRef = db.collection('bookings').doc();
    await bookingRef.set({
      id:              bookingRef.id,
      venueId,
      courtIndex:      courtIndex || 0,
      date,
      timeSlot,
      type:            bookingType.toLowerCase(),
      reason,
      label:           reason,
      bookerName:      userName,
      onBehalfContact: phone.trim(),
      status:          'pending',
      requestedBy:     uid,
      requestedByName: userName,
      requestedAt:     new Date().toISOString(),
    });
    console.log(`[bookGroenkloofCourt] booking ${bookingRef.id} for uid=${uid} (new=${isNewUser})`);

    // Notify venue organizers + admins
    const venueSnap  = await db.collection('venues').doc(venueId).get();
    const venueName  = venueSnap.exists ? (venueSnap.data().name || venueId) : venueId;
    const adminSnap  = await db.collection('users').where('role', 'in', ['admin', 'master']).get();
    const schoolSnap = await db.collection('schools').where('venueId', '==', venueId).get();
    const orgUids    = new Set(adminSnap.docs.map(d => d.id));
    for (const s of schoolSnap.docs) {
      const sd = s.data();
      if (Array.isArray(sd.organisers)) sd.organisers.forEach(o => orgUids.add(o));
      if (sd.contactUid) orgUids.add(sd.contactUid);
    }
    const slotLabel = timeSlot === 'morning' ? 'Morning (07:00–14:00)' : timeSlot === 'afternoon' ? 'Afternoon (14:00–18:00)' : timeSlot;
    const now        = admin.firestore.FieldValue.serverTimestamp();
    const nb         = db.batch();
    const toEmails   = [];
    for (const oid of orgUids) {
      nb.set(db.collection('notifications').doc(), {
        uid: oid, type: 'booking_request',
        title: `Booking request — ${venueName}`,
        body:  `${userName} requested ${slotLabel} on ${date} (${reason})`,
        fromName: userName, bookingId: bookingRef.id, read: false, createdAt: now,
      });
      const uSnap = await db.collection('users').doc(oid).get();
      if (uSnap.exists && uSnap.data().email) toEmails.push(uSnap.data().email);
    }
    await nb.commit();

    if (toEmails.length > 0) {
      const emailUser = EMAIL_USER.value();
      const emailPass = EMAIL_PASS.value();
      if (emailUser && emailPass) {
        try {
          const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });
          await transporter.sendMail({
            from:    `"Court Campus" <${emailUser}>`,
            to:      toEmails.join(', '),
            subject: `[Court Campus] Booking request — ${venueName} ${date}`,
            text: [
              `A booking request has been submitted at ${venueName}.`,
              ``,
              `From:   ${userName} <${email.trim()}> / ${phone.trim()}`,
              `Date:   ${date}`,
              `Slot:   ${slotLabel}`,
              `Court:  Court ${(courtIndex || 0) + 1}`,
              `Reason: ${reason}`,
              ``,
              `Log in to approve or decline: ${APP_URL}`,
            ].join('\n'),
          });
        } catch (e) { console.error('[bookGroenkloofCourt] sendMail failed:', e.message); }
      }
    }

    const customToken = await authAdmin.createCustomToken(uid);
    return { ok: true, bookingId: bookingRef.id, isNewUser, customToken };
  }
);
