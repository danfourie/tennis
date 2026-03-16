# Firebase Setup Guide — Court Campus

This branch replaces `localStorage` with **Firebase Firestore** (database) and
**Firebase Authentication** (master-user login).  Follow the steps below once
to get everything running.

---

## 1 — Create a Firebase Project

1. Go to <https://console.firebase.google.com/>
2. Click **Add project**, give it a name (e.g. `tennis-court-manager`), continue.
3. Disable Google Analytics if you don't need it, then **Create project**.

---

## 2 — Add a Web App

1. Inside your project, click the **`</>`** (Web) icon to add an app.
2. Give it a nickname (e.g. `tennis-web`).
3. **Do NOT** tick "Firebase Hosting" (we use GitHub Pages).
4. Click **Register app**.
5. Copy the `firebaseConfig` object shown — you'll need it in step 4.

---

## 3 — Enable Firestore Database

1. In the left sidebar go to **Build → Firestore Database**.
2. Click **Create database**.
3. Choose **Start in production mode** (our rules handle access).
4. Select a Cloud Firestore location closest to your users, then **Enable**.

---

## 4 — Add Your Config to the App

Open `js/firebase-config.js` and replace the placeholder values:

```js
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy...",
  authDomain:        "your-project-id.firebaseapp.com",
  projectId:         "your-project-id",
  storageBucket:     "your-project-id.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abcdef...",
};
```

> ⚠️  **Never commit real API keys to a public repo.**
> Firebase Web API keys are *not* secret (they identify the project, not grant
> admin access) — security is enforced by Firestore Rules.  But it's still good
> practice to restrict the key in the Google Cloud Console to your GitHub Pages
> domain.

---

## 5 — Create the Master User

The master (admin) user is a regular Firebase Auth account.

1. In the Firebase Console go to **Build → Authentication**.
2. Click **Get started**, then enable **Email/Password** provider.
3. Go to the **Users** tab and click **Add user**.
4. Enter the admin email and a strong password (minimum 6 characters).
5. That email + password is what you use to log in on the Court Campus.

---

## 6 — Deploy Firestore Security Rules

The `firestore.rules` file is already written. Deploy it with the Firebase CLI:

```bash
npm install -g firebase-tools   # one-time install
firebase login
firebase use --add              # select your project
firebase deploy --only firestore:rules
```

Or paste the contents of `firestore.rules` directly into
**Firestore → Rules** in the Firebase Console and click **Publish**.

---

## 7 — Restrict the API Key (Recommended)

1. Go to <https://console.cloud.google.com/apis/credentials>
2. Click on the API key used by your Firebase project.
3. Under **Application restrictions** → select **HTTP referrers (websites)**.
4. Add `https://danfourie.github.io/*` (or your custom domain).
5. Save.

---

## 8 — Push & Go Live

```bash
git add js/firebase-config.js   # only after you've filled it in
git commit -m "chore: add Firebase config"
git push origin feature/firebase-backend
```

Then open a pull request to merge `feature/firebase-backend` into `master`.
GitHub Pages will redeploy automatically.

---

## Data Structure in Firestore

| Collection    | Key fields                                              |
|---------------|----------------------------------------------------------|
| `venues`      | `id`, `name`, `address`, `courts`                       |
| `schools`     | `id`, `name`, `venueId`, `contact`, `color`             |
| `bookings`    | `id`, `venueId`, `courtIndex`, `date`, `timeSlot`, `type`, `label` |
| `leagues`     | `id`, `name`, `division`, `schoolIds`, `fixtures[]`, `standings[]` |
| `tournaments` | `id`, `name`, `drawType`, `numPlayers`, `players[]`, `draw{}` |
| `closures`    | `id`, `venueId`, `courtIndex`, `startDate`, `endDate`   |
| `settings`    | `global` doc: `timeSlotStart`, `timeSlotEnd`, `slotDuration` |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Spinner never goes away | Config placeholder not replaced — check `js/firebase-config.js` |
| "Permission denied" on write | Firestore rules not deployed, or user not signed in |
| Login says "user not found" | Admin user not created in Firebase Auth (step 5) |
| `auth/requires-recent-login` on password change | Log out and sign back in, then change password |
| Real-time updates not working | Check browser console for Firestore listener errors |
