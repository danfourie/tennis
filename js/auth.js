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
  let _user    = null;   // Firebase Auth user
  let _profile = null;   // Firestore user profile document
  let _role    = null;   // 'master' | 'admin' | 'user' | null

  // ── Bootstrap ─────────────────────────────────────────────
  function init() {
    firebase.auth().onAuthStateChanged(async user => {
      _user = user;
      if (user) {
        await _loadProfile(user.uid);

        // _loadProfile signs out deleted users — _profile will be null in that case.
        // Guard against continuing as if authenticated.
        if (!_profile) {
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
      } else {
        // Profile missing. Only auto-create when this is the very first user
        // (empty users collection = first-ever registration). For all other cases
        // the user was deleted by an admin — sign them out immediately.
        const snap = await db.collection('users').limit(1).get();
        if (!snap.empty) {
          // Other users exist → this account was deleted. Sign out.
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
  async function register(email, password, displayName, schoolId = null) {
    try {
      // 1. Create Firebase Auth account
      const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName });

      // 2. Determine role: first registered user becomes master
      const snap = await firebase.firestore().collection('users').limit(1).get();
      const role = snap.empty ? 'master' : 'user';

      // 3. Create Firestore profile
      const profile = {
        uid:         cred.user.uid,
        email,
        displayName,
        role,
        schoolId:    schoolId || null,
        createdAt:   new Date().toISOString(),
      };
      await firebase.firestore().collection('users').doc(cred.user.uid).set(profile);

      _profile = profile;
      _role    = role;

      // Re-sync UI now that role is confirmed — onAuthStateChanged fired
      // earlier (before the profile doc existed) and set role to 'user'.
      _updateUI();
      _refreshViews();

      return { ok: true, role };
    } catch (err) {
      return { ok: false, error: _authMsg(err) };
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

  return {
    init, login, register, logout,
    isAdmin, isMaster, isLoggedIn, currentRole,
    getUser, getProfile, changePassword,
  };
})();
