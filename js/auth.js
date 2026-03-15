/**
 * auth.js — Firebase Authentication with role-based access control
 *
 * Roles:
 *   'master' → full admin (add/edit/delete everything, approve bookings, manage users)
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
 *   Auth.isAdmin()     → true when role === 'master'  (backward-compat alias)
 *   Auth.isMaster()    → true when role === 'master'
 *   Auth.isLoggedIn()  → true for any authenticated user
 *   Auth.currentRole() → 'master' | 'user' | null
 *   Auth.getUser()     → Firebase Auth user object
 *   Auth.getProfile()  → Firestore /users/{uid} document data
 *   Auth.changePassword(pw) → async; throws on failure
 */

const Auth = (() => {
  let _user    = null;   // Firebase Auth user
  let _profile = null;   // Firestore user profile document
  let _role    = null;   // 'master' | 'user' | null

  // ── Bootstrap ─────────────────────────────────────────────
  function init() {
    firebase.auth().onAuthStateChanged(async user => {
      _user = user;
      if (user) {
        await _loadProfile(user.uid);
      } else {
        _profile = null;
        _role    = null;
      }
      _updateUI();
      _refreshViews();
    });
  }

  // ── Load Firestore user profile ────────────────────────────
  async function _loadProfile(uid) {
    try {
      const doc = await firebase.firestore().collection('users').doc(uid).get();
      _profile = doc.exists ? doc.data() : null;
      _role    = _profile ? (_profile.role || 'user') : 'user';
    } catch (err) {
      console.warn('Could not load user profile:', err);
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
  function isAdmin()    { return _role === 'master'; }   // backward-compat
  function isMaster()   { return _role === 'master'; }
  function isLoggedIn() { return _user !== null; }
  function currentRole(){ return _role; }
  function getUser()    { return _user; }
  function getProfile() { return _profile; }

  // ── UI sync ───────────────────────────────────────────────
  function _updateUI() {
    const loggedIn = isLoggedIn();
    const master   = isMaster();

    // Elements only for master
    document.querySelectorAll('.admin-only').forEach(el =>
      el.classList.toggle('hidden', !master)
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
        const name     = _profile
          ? (_profile.displayName || _profile.email)
          : (_user ? _user.email : '');
        const icon     = master ? '🔑' : '👤';
        badge.textContent = `${icon} ${name}`;
      }
    }
  }

  function _refreshViews() {
    // Defer so modules are guaranteed to exist
    setTimeout(() => {
      if (typeof Calendar     !== 'undefined') Calendar.refresh();
      if (typeof Leagues      !== 'undefined') Leagues.refresh();
      if (typeof Tournaments  !== 'undefined') Tournaments.refresh();
      if (typeof Admin        !== 'undefined') Admin.refresh();
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
