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
const APP_URL = 'https://tennissa-planner.web.app';

// ── Switch to Content Templates once all templates are approved in Twilio ─────
// false = plain text body (works in sandbox; no template approval needed)
// true  = use pre-approved WhatsApp Content Templates (required for production)
const USE_CONTENT_TEMPLATES = false;

const TEMPLATE_SIDS = {
  // Fill in after templates are approved in Twilio Console → Content Template Builder
  booking_approved:    'HX_FILL_AFTER_APPROVAL',
  booking_rejected:    'HX_FILL_AFTER_APPROVAL',
  booking_request:     'HX_FILL_AFTER_APPROVAL',
  booking_cancelled:   'HX_FILL_AFTER_APPROVAL',
  fixture_changed:     'HX_FILL_AFTER_APPROVAL',
  fixture_cancelled:   'HX_FILL_AFTER_APPROVAL',
  score_reminder:      'HX_FILL_AFTER_APPROVAL',
  league_entry:        'HX_FILL_AFTER_APPROVAL',
  team_message:        'HX_FILL_AFTER_APPROVAL',
  alt_venue_request:   'HX_FILL_AFTER_APPROVAL',
  registration_invite: 'HX_FILL_AFTER_APPROVAL',
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
    case 'booking_approved':
    case 'booking_cancelled':
      vars['1'] = notif.venueName  || '';
      vars['2'] = notif.date       || '';
      vars['3'] = APP_URL;
      break;
    case 'booking_rejected':
      vars['1'] = notif.venueName  || '';
      vars['2'] = APP_URL;
      break;
    case 'booking_request':
      vars['1'] = notif.fromName   || '';
      vars['2'] = notif.venueName  || '';
      vars['3'] = notif.date       || '';
      vars['4'] = APP_URL;
      break;
    case 'fixture_changed':
    case 'fixture_cancelled':
      vars['1'] = notif.opponent   || '';
      vars['2'] = notif.date       || '';
      vars['3'] = APP_URL;
      break;
    case 'score_reminder':
      vars['1'] = notif.opponent   || '';
      vars['2'] = APP_URL;
      break;
    case 'league_entry':
      vars['1'] = notif.leagueName || '';
      vars['2'] = notif.status     || '';
      vars['3'] = APP_URL;
      break;
    case 'team_message':
      vars['1'] = notif.fromName   || '';
      vars['2'] = notif.date       || '';
      vars['3'] = notif.body       || '';
      vars['4'] = APP_URL;
      break;
    case 'alt_venue_request':
      vars['1'] = notif.fromName   || '';
      vars['2'] = notif.date       || '';
      vars['3'] = APP_URL;
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
      console.log(`[WhatsApp] Sent ${notif.type} to ${phone} — SID: ${msg.sid}`);
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
//   URL: https://us-central1-tennissa-planner.cloudfunctions.net/whatsappWebhook
exports.whatsappWebhook = onRequest(async (req, res) => {
  // Twilio sends URL-encoded POST body
  const fromRaw = req.body && req.body.From ? String(req.body.From) : null;
  const body    = req.body && req.body.Body  ? String(req.body.Body).trim() : null;

  // Twilio expects a 200 response quickly; always respond 200
  if (!fromRaw || !body) return res.sendStatus(200);

  // Strip the "whatsapp:" prefix Twilio prepends
  const fromPhone = fromRaw.replace(/^whatsapp:/i, '');

  // Find the registered user with this phone
  const snap = await admin.firestore()
    .collection('users')
    .where('phone', '==', fromPhone)
    .limit(1)
    .get();

  if (snap.empty) {
    // Try E.164 normalisation in case the stored number has a different format
    const e164 = _toE164(fromPhone);
    const snap2 = e164 && e164 !== fromPhone
      ? await admin.firestore().collection('users').where('phone', '==', e164).limit(1).get()
      : { empty: true };

    if (snap2.empty) {
      console.log(`[WhatsApp] Reply from unrecognised phone: ${fromPhone}`);
      return res.sendStatus(200);
    }
  }

  const userDoc = snap.empty
    ? (await admin.firestore().collection('users').where('phone', '==', _toE164(fromPhone)).limit(1).get()).docs[0]
    : snap.docs[0];

  const user = userDoc.data();

  // Store as an in-app notification so it appears in the notification bell
  await admin.firestore().collection('notifications').add({
    uid:       user.uid,
    type:      'whatsapp_reply',
    title:     '📱 WhatsApp message',
    body,
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
  { secrets: [TWILIO_SID, TWILIO_TOKEN] },
  async (request) => {
    if (!request.auth) throw new Error('Unauthenticated');

    const sid   = TWILIO_SID.value();
    const token = TWILIO_TOKEN.value();
    if (!sid || !token) return { count: 0, cost: '0.00', currency: 'USD' };

    const client = twilio(sid, token);
    const now    = new Date();
    const start  = new Date(now.getFullYear(), now.getMonth(), 1);

    try {
      // Fetch outbound WhatsApp usage records for this month
      const records = await client.usage.records.list({
        category:  'sms-whatsapp-outbound',
        startDate: start,
        endDate:   now,
      });
      if (!records || records.length === 0) return { count: 0, cost: '0.00', currency: 'USD' };
      const r = records[0];
      return {
        count:    parseInt(r.count    || '0', 10),
        cost:     parseFloat(r.price  || '0').toFixed(2),
        currency: r.priceUnit || 'USD',
      };
    } catch (err) {
      console.error('[WhatsApp] Usage query failed:', err.message);
      return { count: 0, cost: '0.00', currency: 'USD' };
    }
  }
);
