/**
 * auth.js — Firebase Authentication
 *
 * Replaces the original password-check system with Firebase Auth.
 * The master user is a normal Firebase Auth account (email + password)
 * created once in the Firebase Console or via the setup flow below.
 *
 * Public API (unchanged shape so no other modules need updating):
 *   Auth.init()          → attach Firebase onAuthStateChanged listener
 *   Auth.login(e, pw)    → sign in; returns { ok, error }
 *   Auth.logout()        → sign out
 *   Auth.isAdmin()       → true when a user is signed in
 *   Auth.changePassword(newPw) → async; throws on failure
 */

const Auth = (() => {
  let _isAdmin = false;
  let _user    = null;

  // ── Bootstrap ─────────────────────────────────────────────
  function init() {
    firebase.auth().onAuthStateChanged(user => {
      _user    = user;
      _isAdmin = !!user;
      _updateUI();
    });
  }

  // ── Sign-in ────────────────────────────────────────────────
  async function login(email, password) {
    try {
      await firebase.auth().signInWithEmailAndPassword(email, password);
      return { ok: true };
    } catch (err) {
      let msg = 'Login failed';
      switch (err.code) {
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
          msg = 'Incorrect email or password'; break;
        case 'auth/invalid-email':
          msg = 'Invalid email address'; break;
        case 'auth/too-many-requests':
          msg = 'Too many attempts — try again later'; break;
        default:
          msg = err.message;
      }
      return { ok: false, error: msg };
    }
  }

  // ── Sign-out ───────────────────────────────────────────────
  function logout() {
    firebase.auth().signOut().catch(console.error);
  }

  // ── Password change (called from admin panel) ──────────────
  async function changePassword(newPassword) {
    if (!_user) throw new Error('Not logged in');
    await _user.updatePassword(newPassword);
  }

  // ── Accessors ─────────────────────────────────────────────
  function isAdmin() { return _isAdmin; }
  function getUser()  { return _user; }

  // ── UI sync ───────────────────────────────────────────────
  function _updateUI() {
    document.querySelectorAll('.admin-only').forEach(el =>
      el.classList.toggle('hidden', !_isAdmin)
    );
    document.getElementById('loginBtn').classList.toggle('hidden', _isAdmin);
    document.getElementById('logoutBtn').classList.toggle('hidden', !_isAdmin);

    const badge = document.getElementById('userBadge');
    badge.classList.toggle('hidden', !_isAdmin);
    if (_isAdmin) {
      const email = _user ? _user.email : 'Master';
      badge.textContent = `🔑 ${email}`;
    }
  }

  return { init, login, logout, isAdmin, getUser, changePassword };
})();
