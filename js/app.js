/**
 * app.js — Main application bootstrap and shared utilities
 *
 * Boot sequence:
 *   1. Show loading overlay
 *   2. firebase.initializeApp(FIREBASE_CONFIG)
 *   3. DB.loadAll()        — fetch all Firestore collections into the in-memory cache
 *   4. DB.subscribeAll()   — attach real-time listeners for live updates
 *   5. Auth.init()         — attach onAuthStateChanged
 *   6. Init all UI modules
 *   7. Hide loading overlay
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

function applyTournamentVisibility() {
  const enabled = DB.getSettings().tournamentPageEnabled === true; // default OFF — only show if explicitly enabled
  const navBtn = document.querySelector('[data-view="tournaments"]');
  if (navBtn) navBtn.classList.toggle('hidden', !enabled);
  // If the user is currently on the tournaments page and it gets disabled, send them to calendar
  if (!enabled) {
    const tourView = document.getElementById('view-tournaments');
    if (tourView && !tourView.classList.contains('hidden')) {
      navigate('calendar');
    }
  }
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
        Check <code>js/firebase-config.js</code> and see <strong>FIREBASE-SETUP.md</strong>.
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

  // ── Validate config ──────────────────────────────────────
  if (!FIREBASE_CONFIG || FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
    showFatalError('Firebase is not configured. Please fill in js/firebase-config.js.');
    return;
  }

  try {
    // ── Initialise Firebase ─────────────────────────────────
    firebase.initializeApp(FIREBASE_CONFIG);

    // ── Load data from Firestore ────────────────────────────
    setLoading(true, 'Loading data…');
    await DB.loadAll();

    // ── Subscribe to real-time updates ──────────────────────
    DB.subscribeAll(collection => {
      if (['venues', 'bookings', 'closures'].includes(collection))             Calendar.refresh();
      if (['venues', 'schools', 'closures', 'leagueEntries', 'leagues'].includes(collection)) Admin.refresh();
      if (['leagues', 'leagueEntries', 'schools', 'venues'].includes(collection))  Leagues.refresh();
      if (['tournaments', 'venues'].includes(collection))                          Tournaments.refresh();
      // MySchool and MyVenue must refresh when league scores / school / booking data change
      if (['leagues', 'schools', 'venues', 'closures', 'bookings'].includes(collection)) {
        if (typeof MySchool !== 'undefined') MySchool.refresh();
        if (typeof MyVenue  !== 'undefined') MyVenue.refresh();
      }
      // Global settings changes (e.g. tournament page toggle) — apply immediately
      if (collection === 'settings') applyTournamentVisibility();
    });

    // ── Initialise UI modules ───────────────────────────────
    Auth.init();
    NotificationService.init();
    Calendar.init();
    Leagues.init();
    Tournaments.init();
    Admin.init();
    MySchool.init();
    MyVenue.init();

  } catch (err) {
    console.error('Firebase init failed:', err);
    showFatalError('Could not connect to Firebase: ' + err.message);
    return;
  }

  setLoading(false);

  // Apply global feature flags from settings
  applyTournamentVisibility();

  // ── Navigation ─────────────────────────────────────────────
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'admin' && !Auth.isAdmin()) return;
      navigate(view);
      // Trigger render for views that need it on activation
      if (view === 'calendar') Calendar.refresh();
      if (view === 'myschool') MySchool.refresh();
      if (view === 'myvenue')  MyVenue.refresh();
    });
  });

  // ── Login ──────────────────────────────────────────────────
  document.getElementById('loginBtn').addEventListener('click', () => {
    document.getElementById('loginEmail').value    = '';
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
  ['loginEmail', 'loginPassword'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });
  });

  document.getElementById('forgotPasswordBtn').addEventListener('click', async () => {
    const email  = document.getElementById('loginEmail').value.trim();
    const errEl  = document.getElementById('loginError');
    const infoEl = document.getElementById('loginInfo');

    errEl.textContent = '';
    infoEl.style.display = 'none';

    if (!email) {
      errEl.textContent = 'Enter your email address above first';
      document.getElementById('loginEmail').focus();
      return;
    }

    const btn = document.getElementById('forgotPasswordBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    const result = await Auth.resetPassword(email);

    btn.disabled = false;
    btn.textContent = 'Forgot password?';

    if (result.ok) {
      infoEl.textContent = `✅ Reset email sent to ${email} — check your inbox.`;
      infoEl.style.display = 'block';
      document.getElementById('loginPassword').value = '';
    } else {
      errEl.textContent = result.error || 'Could not send reset email';
    }
  });

  async function doLogin() {
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl    = document.getElementById('loginError');

    if (!email || !password) { errEl.textContent = 'Enter email and password'; return; }

    const btn = document.getElementById('loginSubmitBtn');
    btn.disabled = true; btn.textContent = 'Signing in…';
    errEl.textContent = '';

    const result = await Auth.login(email, password);

    btn.disabled = false; btn.textContent = 'Login';

    if (result.ok) {
      Modal.close('loginModal');
      toast('Welcome back! 🎾', 'success');
    } else {
      errEl.textContent = result.error || 'Login failed';
    }
  }

  // ── Register ───────────────────────────────────────────────
  document.getElementById('registerBtn').addEventListener('click', () => {
    // Populate school dropdown
    const sel = document.getElementById('regSchool');
    sel.innerHTML = '<option value="">-- No school --</option>' +
      DB.getSchools().map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    // Clear form
    ['regName','regEmail','regPassword','regPasswordConfirm','regPhone'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('regWhatsApp').checked = false;
    document.getElementById('registerError').textContent = '';
    Modal.open('registerModal');
    setTimeout(() => document.getElementById('regName').focus(), 50);
  });

  document.getElementById('registerSubmitBtn').addEventListener('click', doRegister);
  document.getElementById('regPasswordConfirm').addEventListener('keydown', e => {
    if (e.key === 'Enter') doRegister();
  });

  async function doRegister() {
    const name          = document.getElementById('regName').value.trim();
    const email         = document.getElementById('regEmail').value.trim();
    const password      = document.getElementById('regPassword').value;
    const confirm       = document.getElementById('regPasswordConfirm').value;
    const schoolId      = document.getElementById('regSchool').value || null;
    const phone         = document.getElementById('regPhone').value.trim() || null;
    const whatsappOptIn = !!(phone && document.getElementById('regWhatsApp').checked);
    const errEl         = document.getElementById('registerError');

    if (!name)                      { errEl.textContent = 'Full name is required';              return; }
    if (!email)                     { errEl.textContent = 'Email is required';                   return; }
    if (password.length < 6)        { errEl.textContent = 'Password must be at least 6 characters'; return; }
    if (password !== confirm)       { errEl.textContent = 'Passwords do not match';              return; }

    const btn = document.getElementById('registerSubmitBtn');
    btn.disabled = true; btn.textContent = 'Creating account…';
    errEl.textContent = '';

    const result = await Auth.register(email, password, name, schoolId, phone, whatsappOptIn);

    btn.disabled = false; btn.textContent = 'Create Account';

    if (result.ok) {
      Modal.close('registerModal');
      const isMaster = result.role === 'master';
      toast(
        isMaster ? 'Welcome, Master! You are the first user. 🔑' : 'Account created! Welcome 🎾',
        'success'
      );
      if (isMaster) navigate('admin');
    } else {
      errEl.textContent = result.error || 'Registration failed';
    }
  }

  // ── Modal close buttons ────────────────────────────────────
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

  navigate('calendar');
});
