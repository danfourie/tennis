'use strict';
/**
 * One-off: set noBookingRequests=true on a user so they stop receiving
 * court booking request notification emails.
 *
 * Run from the functions/ directory:
 *   node set_no_booking_requests.js jendev7@gmail.com
 */
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  require('os').homedir() + '/AppData/Roaming/firebase/danfourie_gmail_com_application_default_credentials.json';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'tennissa-planner' });
const db = admin.firestore();

const email = process.argv[2];
if (!email) { console.error('Usage: node set_no_booking_requests.js <email>'); process.exit(1); }

(async () => {
  const snap = await db.collection('users').where('email', '==', email).get();
  if (snap.empty) { console.error(`No user found with email: ${email}`); process.exit(1); }
  const doc = snap.docs[0];
  console.log(`Found: uid=${doc.id}  name="${doc.data().displayName}"  email="${doc.data().email}"`);
  await db.collection('users').doc(doc.id).update({ noBookingRequests: true });
  console.log('Done — noBookingRequests=true set.');
  process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
