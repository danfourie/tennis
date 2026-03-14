/**
 * auth.js — Authentication management
 */

const Auth = (() => {
  let _isAdmin = false;
  const SESSION_KEY = 'tcm_session';

  function init() {
    // Restore session
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored === 'admin') {
      _isAdmin = true;
      _updateUI();
    }
  }

  function login(password) {
    if (password === DB.getPassword()) {
      _isAdmin = true;
      sessionStorage.setItem(SESSION_KEY, 'admin');
      _updateUI();
      return true;
    }
    return false;
  }

  function logout() {
    _isAdmin = false;
    sessionStorage.removeItem(SESSION_KEY);
    _updateUI();
  }

  function isAdmin() { return _isAdmin; }

  function _updateUI() {
    const adminEls = document.querySelectorAll('.admin-only');
    adminEls.forEach(el => el.classList.toggle('hidden', !_isAdmin));
    document.getElementById('loginBtn').classList.toggle('hidden', _isAdmin);
    document.getElementById('logoutBtn').classList.toggle('hidden', !_isAdmin);
    const badge = document.getElementById('userBadge');
    badge.classList.toggle('hidden', !_isAdmin);
    if (_isAdmin) badge.textContent = '🔑 Master';
  }

  return { init, login, logout, isAdmin };
})();
