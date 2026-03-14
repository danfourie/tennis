/**
 * app.js — Main application bootstrap and shared utilities
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
// BOOTSTRAP
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  // Init modules
  Auth.init();
  Calendar.init();
  Leagues.init();
  Tournaments.init();
  Admin.init();

  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'admin' && !Auth.isAdmin()) return;
      navigate(view);
    });
  });

  // Login button
  document.getElementById('loginBtn').addEventListener('click', () => {
    document.getElementById('loginPassword').value = '';
    Modal.open('loginModal');
    setTimeout(() => document.getElementById('loginPassword').focus(), 50);
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    Auth.logout();
    navigate('calendar');
    toast('Logged out');
  });

  document.getElementById('loginSubmitBtn').addEventListener('click', doLogin);
  document.getElementById('loginPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });

  function doLogin() {
    const pw = document.getElementById('loginPassword').value;
    if (Auth.login(pw)) {
      Modal.close('loginModal');
      Admin.refresh();
      Calendar.refresh();
      Leagues.refresh();
      Tournaments.refresh();
      toast('Welcome, Master! 🔑', 'success');
    } else {
      document.getElementById('loginPassword').value = '';
      toast('Incorrect password', 'error');
    }
  }

  // Modal close buttons (data-modal attribute)
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-modal]');
    if (btn) Modal.close(btn.dataset.modal);

    // Close on overlay click
    if (e.target.classList.contains('modal-overlay')) {
      const id = e.target.id;
      if (id) Modal.close(id);
    }
  });

  // Keyboard close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => {
        Modal.close(m.id);
      });
    }
  });

  // Initial view
  navigate('calendar');
});
