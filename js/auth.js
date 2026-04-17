/**
 * auth.js — Firebase Authentication with role-based access control
 *
 * Roles:
 *   'master' → superuser (first registrant; full control incl. managing other masters)
 *   'admin'  → same privileges as master — add/edit/delete everything, manage users
 *   'user'   → registered user (request bookings, submit scores, view everything)
 *    null    → anonymous visitor (view only)
 *
 * First user to register on a fresh Firestore project automatically becomes master.
 *
 * Public API:
 *   Auth.init()                              → attach Firebase listeners
 *   Auth.login(email, pw)                    → { ok, error }
 *   Auth.register(email, pw, name, schoolId) → { ok, role, error }
 *   Auth.logout()
 *   Auth.isAdmin()     → true when role === 'master' OR 'admin'
 *   Auth.isMaster()    → true when role === 'master' only
 *   Auth.isLoggedIn()  → true for any authenticated user
 *   Auth.currentRole() → 'master' | 'admin' | 'user' | null
 *   Auth.getUser()     → Firebase Auth user object
 *   Auth.getProfile()  → Firestore /users/{uid} document data
 *   Auth.changePassword(pw) → async; throws on failure
 */

const Auth = (() => {
  let _user             = null;   // Firebase Auth user
  let _profile          = null;   // Firestore user profile document
  let _role             = null;   // 'master' | 'admin' | 'user' | null
  let _profileUnsub     = null;   // unsubscribe fn for profile live-listener
  let _registering      = false;  // true while register() is writing the profile doc

  // ── Bootstrap ─────────────────────────────────────────────
  function init() {
    firebase.auth().onAuthStateChanged(async user => {
      _user = user;
      if (user) {
        await _loadProfile(user.uid);

        // _loadProfile signs out deleted users — _profile will be null in that case.
        // Guard against continuing as if authenticated.
        // Exception: if register() is in flight the profile hasn't been written yet.
        if (!_profile) {
          if (_registering) return; // register() will set _profile and refresh UI
          _user = null;
          if (typeof toast === 'function') {
            toast('Your account has been removed. Please register again.', 'error');
          }
          _updateUI();
          _refreshViews();
          return;
        }

        // Bookings require authentication — load now that the user is signed in
        await DB.loadBookings();
        if (typeof Calendar !== 'undefined') Calendar.refresh();
      } else {
        if (_profileUnsub) { _profileUnsub(); _profileUnsub = null; }
        _profile = null;
        _role    = null;
        DB.clearBookings();
        if (typeof NotificationService !== 'undefined') NotificationService.unload();
        if (typeof Calendar !== 'undefined') Calendar.refresh();
      }
      _updateUI();
      _refreshViews();
    });
  }

  // ── Load Firestore user profile ────────────────────────────
  // If no profile document exists (e.g. Firestore write failed at registration),
  // we create one automatically. First user in the collection becomes master.
  async function _loadProfile(uid) {
    // During registration, register() sets _profile/_role directly and attaches
    // the live listener itself. Skip all Firestore reads here to avoid auth-token
    // timing issues that could trigger the catch-block signOut.
    if (_registering) return;
    try {
      const db  = firebase.firestore();
      const ref = db.collection('users').doc(uid);
      // Force a server read so that if an admin deleted this profile on another
      // device the stale offline-cache copy is never used to grant access.
      const doc = await ref.get({ source: 'server' });

      if (doc.exists) {
        _profile = doc.data();
        _role    = _profile.role || 'user';
        console.log('[Auth] profile loaded — uid:', uid, '| role:', _role);
        if (typeof NotificationService !== 'undefined') NotificationService.loadForCurrentUser();

        // ── Record login timestamp (fire-and-forget; never blocks the UI) ──────
        // Keep a rolling log of the last 20 session-start timestamps so admins
        // can see registration date + full login history per user.
        const now      = new Date().toISOString();
        const loginLog = [now, ...(_profile.loginLog || [])].slice(0, 20);
        ref.update({ lastLoginAt: now, loginLog }).catch(() => {});
        _profile.lastLoginAt = now;
        _profile.loginLog    = loginLog;

        // ── Live profile listener ────────────────────────────────────────────
        // Keep _profile in sync so that admin changes (e.g. managedVenueIds,
        // role) are reflected in the current session without requiring a logout.
        if (_profileUnsub) _profileUnsub();
        _profileUnsub = ref.onSnapshot(snap => {
          if (!snap.exists || !_user) return;
          const updated = snap.data();
          _profile = updated;
          _role    = updated.role || 'user';
          _updateUI();
          _refreshViews();
        }, () => { /* ignore listener errors — stale data is fine */ });
      } else {
        // Profile missing. Only auto-create when this is the very first user
        // (empty users collection = first-ever registration). For all other cases
        // the user was deleted by an admin — sign them out immediately.
        const snap = await db.collection('users').limit(1).get();
        if (!snap.empty) {
          // Other users exist → this account was deleted. Sign out.
          // Exception: if register() is currently in flight the profile hasn't
          // been written yet — don't sign out, it will appear momentarily.
          if (_registering) return;
          console.warn('[Auth] No profile found for uid:', uid, '— account was deleted. Signing out.');
          await firebase.auth().signOut();
          _profile = null;
          _role    = null;
          return;
        }
        // No users at all → first-ever user becomes master.
        console.warn('[Auth] No profile found for uid:', uid, '— first user, creating master account.');
        const fbUser = firebase.auth().currentUser;
        _profile = {
          uid,
          email:       fbUser ? fbUser.email       : '',
          displayName: fbUser ? (fbUser.displayName || fbUser.email) : '',
          role:        'master',
          schoolId:    null,
          createdAt:   new Date().toISOString(),
        };
        await ref.set(_profile);
        _role = 'master';
        console.log('[Auth] first master profile created');
        if (typeof NotificationService !== 'undefined') NotificationService.loadForCurrentUser();
      }
    } catch (err) {
      // Sign out on any unexpected error — do not fall back to a permissive role.
      console.warn('[Auth] Could not load user profile:', err.code, err.message);
      _profile = null;
      _role    = null;
      firebase.auth().signOut().catch(() => {});
    }
  }

  // ── Sign-in ────────────────────────────────────────────────
  async function login(email, password) {
    try {
      const cred = await firebase.auth().signInWithEmailAndPassword(email, password);

      // Check that a Firestore profile exists. Admin may have removed the user
      // profile while their Firebase Auth account still exists. Force a server
      // fetch (source:'server') to bypass any offline/local cache.
      const db  = firebase.firestore();
      const doc = await db.collection('users').doc(cred.user.uid).get({ source: 'server' });
      if (!doc.exists) {
        await firebase.auth().signOut();
        return { ok: false, error: 'Your account has been removed. Please register to request access again.' };
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: _authMsg(err) };
    }
  }

  // ── Register ───────────────────────────────────────────────
  /** Normalise a South African phone to E.164 (+27...) */
  function _toE164(phone) {
    if (!phone) return null;
    const clean = String(phone).replace(/[\s\-\(\)\.]/g, '');
    if (clean.startsWith('+'))  return clean;
    if (clean.startsWith('27')) return '+' + clean;
    if (clean.startsWith('0'))  return '+27' + clean.slice(1);
    return '+27' + clean;
  }

  async function register(email, password, displayName, schoolId = null, phone = null, whatsappOptIn = false) {
    _registering = true;
    try {
      // 1. Create Firebase Auth account
      const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName });

      // Ensure Firestore receives the new auth token before making any reads/writes.
      // Without this, the Firestore SDK may still treat the request as unauthenticated
      // immediately after account creation, causing "Missing or insufficient permissions".
      await cred.user.getIdToken(true);

      // 2. Determine role: first registered user becomes master
      const snap = await firebase.firestore().collection('users').limit(1).get();
      const role = snap.empty ? 'master' : 'user';

      // 3. Create Firestore profile
      const normPhone = _toE164(phone);
      const profile = {
        uid:            cred.user.uid,
        email,
        displayName,
        role,
        schoolId:       schoolId      || null,
        phone:          normPhone     || null,
        whatsappOptIn:  !!(normPhone && whatsappOptIn),
        createdAt:      new Date().toISOString(),
      };
      const ref = firebase.firestore().collection('users').doc(cred.user.uid);
      await ref.set(profile);

      // 4. Set profile/role directly — avoid calling _loadProfile while
      //    onAuthStateChanged may already have a _loadProfile in flight.
      _registering = false;
      _profile = profile;
      _role    = role;

      // 4b. Audit log — record the registration event.
      if (typeof DB !== 'undefined') {
        DB.writeAudit(
          'user_registered', 'user',
          `${displayName} (${email}) registered${role === 'master' ? ' as master' : ''}`,
          cred.user.uid, displayName
        );
      }

      // 5. Attach the live profile listener (role changes reflected without re-login).
      if (_profileUnsub) _profileUnsub();
      _profileUnsub = ref.onSnapshot(s => {
        if (!s.exists || !_user) return;
        const updated = s.data();
        _profile = updated;
        _role    = updated.role || 'user';
        _updateUI();
        _refreshViews();
      }, () => {});

      // 6. Load bookings (onAuthStateChanged returned early, so they weren't loaded).
      await DB.loadBookings();

      _updateUI();
      _refreshViews();

      return { ok: true, role };
    } catch (err) {
      return { ok: false, error: _authMsg(err) };
    } finally {
      _registering = false;
    }
  }

  // ── Sign-out ───────────────────────────────────────────────
  function logout() {
    firebase.auth().signOut().catch(console.error);
  }

  // ── Password change ────────────────────────────────────────
  async function changePassword(newPassword) {
    if (!_user) throw new Error('Not logged in');
    await _user.updatePassword(newPassword);
  }

  // ── Accessors ─────────────────────────────────────────────
  function isAdmin()    { return _role === 'master' || _role === 'admin'; }
  function isMaster()   { return _role === 'master'; }
  function isLoggedIn() { return _user !== null; }
  function currentRole(){ return _role; }
  function getUser()    { return _user; }
  function getProfile() { return _profile; }

  // ── UI sync ───────────────────────────────────────────────
  function _updateUI() {
    const loggedIn  = isLoggedIn();
    const adminUser = isAdmin();   // true for both master and admin roles

    // Elements only for master/admin
    document.querySelectorAll('.admin-only').forEach(el =>
      el.classList.toggle('hidden', !adminUser)
    );
    // Elements for any logged-in user
    document.querySelectorAll('.user-only').forEach(el =>
      el.classList.toggle('hidden', !loggedIn)
    );

    const loginBtn    = document.getElementById('loginBtn');
    const logoutBtn   = document.getElementById('logoutBtn');
    const registerBtn = document.getElementById('registerBtn');

    if (loginBtn)    loginBtn.classList.toggle('hidden', loggedIn);
    if (logoutBtn)   logoutBtn.classList.toggle('hidden', !loggedIn);
    if (registerBtn) registerBtn.classList.toggle('hidden', loggedIn);

    const badge = document.getElementById('userBadge');
    if (badge) {
      badge.classList.toggle('hidden', !loggedIn);
      if (loggedIn) {
        const name = _profile
          ? (_profile.displayName || _profile.email)
          : (_user ? _user.email : '');
        const icon = _role === 'master' ? '🔑' : _role === 'admin' ? '🛡️' : '👤';
        badge.textContent = `${icon} ${name}`;
        badge.style.cursor = 'pointer';
        badge.title = 'Edit profile';
        badge.onclick = () => openProfileModal();
      }
    }

    // "My School" nav button — visible only when logged in with a school
    const mySchoolBtn = document.querySelector('[data-view="myschool"]');
    if (mySchoolBtn) {
      const hasSchool = loggedIn && _profile && _profile.schoolId;
      mySchoolBtn.classList.toggle('hidden', !hasSchool);
    }

    // Re-apply global feature-flag visibility (e.g. Tournaments tab) so that
    // auth state changes don't accidentally override the setting.
    if (typeof applyTournamentVisibility === 'function') applyTournamentVisibility();
  }

  function _refreshViews() {
    // Defer so modules are guaranteed to exist
    setTimeout(() => {
      if (typeof Calendar    !== 'undefined') Calendar.refresh();
      if (typeof Leagues     !== 'undefined') Leagues.refresh();
      if (typeof Tournaments !== 'undefined') Tournaments.refresh();
      if (typeof MySchool    !== 'undefined') MySchool.refresh();
      if (typeof MyVenue     !== 'undefined') MyVenue.refresh();
      if (typeof Admin       !== 'undefined') Admin.refresh();
    }, 0);
  }

  // ── Profile modal ─────────────────────────────────────────
  function openProfileModal() {
    if (!_profile) return;
    const nameEl    = document.getElementById('profileName');
    const phoneEl   = document.getElementById('profilePhone');
    const optInEl   = document.getElementById('profileWhatsApp');
    const errEl     = document.getElementById('profileError');
    if (!nameEl) return;
    nameEl.value   = _profile.displayName || '';
    phoneEl.value  = _profile.phone        || '';
    optInEl.checked = !!_profile.whatsappOptIn;
    if (errEl) errEl.textContent = '';
    Modal.open('profileModal');

    const saveBtn = document.getElementById('profileSaveBtn');
    if (saveBtn) {
      // Replace to avoid duplicate listeners
      const fresh = saveBtn.cloneNode(true);
      saveBtn.parentNode.replaceChild(fresh, saveBtn);
      fresh.addEventListener('click', async () => {
        const name  = nameEl.value.trim();
        const raw   = phoneEl.value.trim();
        const optIn = optInEl.checked;
        if (!name) { if (errEl) errEl.textContent = 'Name is required'; return; }
        if (optIn && !raw) { if (errEl) errEl.textContent = 'Enter a phone number to enable WhatsApp'; return; }

        // Normalise to E.164
        const phone = raw
          ? (raw.startsWith('+') ? raw : raw.startsWith('0') ? '+27' + raw.slice(1) : '+27' + raw)
          : null;

        fresh.disabled = true; fresh.textContent = 'Saving…';
        try {
          await _user.updateProfile({ displayName: name });
          const updated = { ..._profile, displayName: name, phone: phone || null, whatsappOptIn: !!(phone && optIn) };
          DB.updateUser(updated);
          _profile = updated;
          _updateUI();
          Modal.close('profileModal');
          if (typeof toast === 'function') toast('Profile saved ✓', 'success');
        } catch (err) {
          if (errEl) errEl.textContent = err.message;
        } finally {
          fresh.disabled = false; fresh.textContent = 'Save';
        }
      });
    }
  }

  // ── Auth error messages ────────────────────────────────────
  function _authMsg(err) {
    switch (err.code) {
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':  return 'Incorrect email or password';
      case 'auth/invalid-email':       return 'Invalid email address';
      case 'auth/email-already-in-use':return 'Email already registered';
      case 'auth/weak-password':       return 'Password must be at least 6 characters';
      case 'auth/too-many-requests':   return 'Too many attempts — try again later';
      default: return err.message;
    }
  }

  // ── Password reset ─────────────────────────────────────────
  // The email link domain is controlled by Firebase Auth's callbackUri setting
  // (set via Identity Toolkit API to https://www.courtcampus.co.za).
  // Firebase will send a link to ?mode=resetPassword&oobCode=... on our domain,
  // which app.js detects on arrival and shows the Set New Password modal.
  async function resetPassword(email) {
    try {
      await firebase.auth().sendPasswordResetEmail(email);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: _authMsg(err) };
    }
  }

  // Called when the user submits a new password after clicking the email link.
  async function confirmNewPassword(oobCode, newPassword) {
    try {
      await firebase.auth().confirmPasswordReset(oobCode, newPassword);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: _authMsg(err) };
    }
  }

  return {
    init, login, register, logout,
    isAdmin, isMaster, isLoggedIn, currentRole,
    getUser, getProfile, changePassword, openProfileModal,
    resetPassword, confirmNewPassword,
  };
})();
