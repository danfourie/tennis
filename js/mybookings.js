/**
 * mybookings.js — "My Bookings" view
 *
 * Shows all bookings made by the currently logged-in user, sorted with
 * upcoming first and past bookings collapsed below.  Status badges and
 * venue/court/slot details are shown per booking.
 */

const MyBookings = (() => {

  // ── helpers ───────────────────────────────────────────────────

  function _venueMap() {
    return Object.fromEntries(DB.getVenues().map(v => [v.id, v]));
  }

  function _slotLabel(slot) {
    if (slot === 'morning')   return 'Morning (07:00–14:00)';
    if (slot === 'afternoon') return 'Afternoon (14:00–18:00)';
    return slot || '';
  }

  function _courtLabel(b, venue) {
    if (!venue) return `Court ${(b.courtIndex || 0) + 1}`;
    const courts = venue.courts;
    if (Array.isArray(courts) && courts[b.courtIndex]) {
      return courts[b.courtIndex].name || `Court ${(b.courtIndex || 0) + 1}`;
    }
    return `Court ${(b.courtIndex || 0) + 1}`;
  }

  function _statusBadge(status) {
    const map = {
      pending:   { label: 'Pending',   color: '#d97706', bg: '#fef3c7' },
      confirmed: { label: 'Confirmed', color: '#059669', bg: '#d1fae5' },
      cancelled: { label: 'Cancelled', color: '#6b7280', bg: '#f3f4f6' },
      rejected:  { label: 'Rejected',  color: '#dc2626', bg: '#fee2e2' },
    };
    const s = map[status] || { label: status || 'Unknown', color: '#6b7280', bg: '#f3f4f6' };
    return `<span style="font-size:.75rem;font-weight:600;padding:.2rem .55rem;border-radius:999px;background:${s.bg};color:${s.color};white-space:nowrap">${s.label}</span>`;
  }

  function _bookingCard(b, venues) {
    const venue = venues[b.venueId];
    const groupTag = b.groupId
      ? `<span style="font-size:.72rem;color:var(--neutral);margin-left:.35rem">(group)</span>` : '';
    return `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin-bottom:.5rem">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;flex-wrap:wrap">
          <div>
            <div style="font-weight:600;font-size:.95rem">${esc(venue ? venue.name : b.venueId)}${groupTag}</div>
            <div style="font-size:.85rem;color:var(--neutral);margin-top:.15rem">
              ${formatDate(b.date)} &middot; ${esc(_slotLabel(b.timeSlot))} &middot; ${esc(_courtLabel(b, venue))}
            </div>
            ${b.reason ? `<div style="font-size:.82rem;color:var(--neutral);margin-top:.1rem">${esc(b.reason)}</div>` : ''}
          </div>
          ${_statusBadge(b.status)}
        </div>
      </div>`;
  }

  // ── render ────────────────────────────────────────────────────

  function render() {
    const el = document.getElementById('myBookingsContent');
    if (!el) return;

    if (!Auth.isLoggedIn()) {
      el.innerHTML = `<div class="empty-state"><p class="text-muted">Please log in to view your bookings.</p></div>`;
      return;
    }

    const user = Auth.getUser();
    if (!user) return;

    const today   = toDateStr(new Date());
    const venues  = _venueMap();

    const all = DB.getBookings()
      .filter(b => b.requestedBy === user.uid && !b.deleted)
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    const upcoming = all.filter(b => b.date >= today);
    const past     = all.filter(b => b.date <  today).reverse();

    if (all.length === 0) {
      el.innerHTML = `<div class="empty-state"><p class="text-muted">You have no bookings yet.</p></div>`;
      return;
    }

    const upcomingHtml = upcoming.length > 0
      ? upcoming.map(b => _bookingCard(b, venues)).join('')
      : `<p style="font-size:.88rem;color:var(--neutral);margin-bottom:1rem">No upcoming bookings.</p>`;

    const pastHtml = past.length > 0
      ? `<details style="margin-top:1.25rem">
          <summary style="font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--neutral);cursor:pointer;user-select:none;padding:.25rem 0">
            Past bookings (${past.length})
          </summary>
          <div style="margin-top:.6rem">${past.map(b => _bookingCard(b, venues)).join('')}</div>
        </details>`
      : '';

    el.innerHTML = `
      <div style="font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--neutral);margin-bottom:.6rem">
        Upcoming (${upcoming.length})
      </div>
      ${upcomingHtml}
      ${pastHtml}`;
  }

  // ── lifecycle ─────────────────────────────────────────────────

  function refresh() {
    const view = document.getElementById('view-mybookings');
    if (!view || view.classList.contains('hidden')) return;
    render();
  }

  function init() {}

  return { init, refresh, render };
})();
