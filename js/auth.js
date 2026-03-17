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
      } else {
        _profile = null;
        _role    = null;
        if (typeof NotificationService !== 'undefined') NotificationService.unload();
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
      const doc = await ref.get();

      if (doc.exists) {
        _profile = doc.data();
        _role    = _profile.role || 'user';
        console.log('[Auth] profile loaded — uid:', uid, '| role:', _role);
        if (typeof NotificationService !== 'undefined') NotificationService.loadForCurrentUser();
      } else {
        // Profile missing — create it now (happens when Firestore rules blocked
        // the write during registration, or when the DB was empty at first run).
        console.warn('[Auth] No profile found for uid:', uid, '— creating one now');
        const snap   = await db.collection('users').limit(1).get();
        const role   = snap.empty ? 'master' : 'user';
        const fbUser = firebase.auth().currentUser;
        _profile = {
          uid,
          email:       fbUser ? fbUser.email       : '',
          displayName: fbUser ? (fbUser.displayName || fbUser.email) : '',
          role,
          schoolId:    null,
          createdAt:   new Date().toISOString(),
        };
        await ref.set(_profile);
        _role = role;
        console.log('[Auth] profile created — role:', _role);
        if (typeof NotificationService !== 'undefined') NotificationService.loadForCurrentUser();
      }
    } catch (err) {
      console.warn('[Auth] Could not load/create user profile:', err.code, err.message);
      _role = 'user';
    }
  }

  // ── Sign-in ────────────────────────────────────────────────
  async function login(email, password) {
    try {
      await firebase.auth().signInWithEmailAndPassword(email, password);
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
  }

  function _refreshViews() {
    // Defer so modules are guaranteed to exist
    setTimeout(() => {
      if (typeof Calendar    !== 'undefined') Calendar.refresh();
      if (typeof Leagues     !== 'undefined') Leagues.refresh();
      if (typeof Tournaments !== 'undefined') Tournaments.refresh();
      if (typeof MySchool    !== 'undefined') MySchool.refresh();
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
