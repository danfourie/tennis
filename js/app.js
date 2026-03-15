/**
 * app.js — Main application bootstrap and shared utilities
 *
 * Firebase initialisation is async, so the boot sequence is:
 *   1. DOMContentLoaded fires
 *   2. Show loading overlay
 *   3. firebase.initializeApp(FIREBASE_CONFIG)
 *   4. DB.loadAll()  — fetch all Firestore collections into the in-memory cache
 *   5. DB.subscribeAll() — attach real-time listeners for live updates
 *   6. Auth.init()   — attach onAuthStateChanged
 *   7. Init all UI modules (Calendar, Leagues, Tournaments, Admin)
 *   8. Hide loading overlay
 */

// ================================================================
// MODAL MANAGER
// ================================================================
const Modal = (() => {
  function open(id) {
    document.getElementById(id).classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function close(id) {
    document.getElementById(id).classList.add('hidden');
    document.body.style.overflow = '';
  }
  return { open, close };
})();

// ================================================================
// TOAST
// ================================================================
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ================================================================
// ESCAPE HTML
// ================================================================
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================================================================
// NAVIGATION
// ================================================================
function navigate(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const viewEl = document.getElementById('view-' + view);
  if (viewEl) viewEl.classList.remove('hidden');
  const navBtn = document.querySelector(`[data-view="${view}"]`);
  if (navBtn) navBtn.classList.add('active');
}

// ================================================================
// LOADING OVERLAY
// ================================================================
function setLoading(visible, message) {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !visible);
  if (message) {
    const msgEl = overlay.querySelector('.loading-message');
    if (msgEl) msgEl.textContent = message;
  }
}

function showFatalError(msg) {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  overlay.innerHTML = `
    <div class="loading-box error-box">
      <div class="loading-icon">⚠️</div>
      <div class="loading-message">${esc(msg)}</div>
      <p style="font-size:.85rem;color:#6b7280;margin-top:.5rem">
        Check your Firebase configuration in <code>js/firebase-config.js</code>
        and see <strong>FIREBASE-SETUP.md</strong> for instructions.
      </p>
      <button onclick="location.reload()" class="btn btn-primary" style="margin-top:1rem">Retry</button>
    </div>`;
  overlay.classList.remove('hidden');
}

// ================================================================
// BOOTSTRAP
// ================================================================
document.addEventListener('DOMContentLoaded', async () => {

  setLoading(true, 'Connecting to Firebase…');

  // ── 1. Validate config ──────────────────────────────────
  if (!FIREBASE_CONFIG || FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
    showFatalError('Firebase is not configured. Please fill in js/firebase-config.js.');
    return;
  }

  try {
    // ── 2. Initialise Firebase ───────────────────────────
    firebase.initializeApp(FIREBASE_CONFIG);

    // ── 3. Load all data from Firestore ──────────────────
    setLoading(true, 'Loading data…');
    await DB.loadAll();

    // ── 4. Subscribe to real-time updates ────────────────
    DB.subscribeAll(collection => {
      // Re-render the relevant view whenever Firestore pushes an update
      if (['venues', 'bookings', 'closures'].includes(collection)) Calendar.refresh();
      if (['venues', 'schools', 'closures'].includes(collection)) Admin.refresh();
      if (['leagues', 'schools', 'venues'].includes(collection)) Leagues.refresh();
      if (['tournaments', 'venues'].includes(collection)) Tournaments.refresh();
    });

    // ── 5. Initialise modules ────────────────────────────
    Auth.init();
    Calendar.init();
    Leagues.init();
    Tournaments.init();
    Admin.init();

  } catch (err) {
    console.error('Firebase init failed:', err);
    showFatalError('Could not connect to Firebase: ' + err.message);
    return;
  }

  setLoading(false);

  // ── Navigation ───────────────────────────────────────────
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'admin' && !Auth.isAdmin()) return;
      navigate(view);
    });
  });

  // ── Login button ─────────────────────────────────────────
  document.getElementById('loginBtn').addEventListener('click', () => {
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').textContent = '';
    Modal.open('loginModal');
    setTimeout(() => document.getElementById('loginEmail').focus(), 50);
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    Auth.logout();
    navigate('calendar');
    toast('Logged out');
  });

  document.getElementById('loginSubmitBtn').addEventListener('click', doLogin);

  // Allow Enter key in either login field
  ['loginEmail', 'loginPassword'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });

  async function doLogin() {
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl    = document.getElementById('loginError');

    if (!email || !password) {
      errEl.textContent = 'Enter email and password';
      return;
    }

    const loginBtn = document.getElementById('loginSubmitBtn');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';
    errEl.textContent = '';

    const result = await Auth.login(email, password);

    loginBtn.disabled = false;
    loginBtn.textContent = 'Login';

    if (result.ok) {
      Modal.close('loginModal');
      Admin.refresh();
      Calendar.refresh();
      Leagues.refresh();
      Tournaments.refresh();
      toast('Welcome, Master! 🔑', 'success');
    } else {
      errEl.textContent = result.error || 'Login failed';
    }
  }

  // ── Modal close buttons ──────────────────────────────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-modal]');
    if (btn) Modal.close(btn.dataset.modal);

    if (e.target.classList.contains('modal-overlay')) {
      const id = e.target.id;
      if (id) Modal.close(id);
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => {
        Modal.close(m.id);
      });
    }
  });

  // ── Initial view ─────────────────────────────────────────
  navigate('calendar');
});
