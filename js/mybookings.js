/**
 * mybookings.js — "My Bookings" view
 *
 * Active (upcoming):  date >= today  AND  status pending | confirmed
 * History:            date <  today  OR   status cancelled | rejected
 *
 * Cancel is available on active bookings outside the 4-hour cutoff.
 * Multi-slot groups are collapsed together with a single "Cancel All" action.
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

  // One row inside a card — optionally with an individual cancel button
  function _slotRow(b, venue, showCancel) {
    const slotCancelBtn = showCancel
      ? `<button class="btn btn-sm btn-danger mb-cancel-btn"
             style="font-size:.72rem;padding:.15rem .5rem;margin-left:.25rem"
             data-ids="${b.id}"
             data-groupid=""
             data-label="${esc(b.reason || b.label || _slotLabel(b.timeSlot))}"
             data-date="${b.date}">Cancel</button>`
      : '';
    return `
      <div style="font-size:.85rem;color:var(--neutral);display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;padding:.18rem 0">
        <span>${formatDate(b.date)}</span>
        <span style="opacity:.4">&middot;</span>
        <span>${esc(_slotLabel(b.timeSlot))}</span>
        <span style="opacity:.4">&middot;</span>
        <span>${esc(_courtLabel(b, venue))}</span>
        ${_statusBadge(b.status)}
        ${slotCancelBtn}
      </div>`;
  }

  // Full card for a single booking or a group
  function _card(slots, venues, canCancel) {
    const first   = slots[0];
    const venue   = venues[first.venueId];
    const isGroup = slots.length > 1;
    const allActive = slots.every(b => b.status === 'pending' || b.status === 'confirmed');
    const allowedToCancel = canCancel && allActive && bookingCancellationAllowed(first);

    // "Cancel All Slots" button — only shown for groups
    const cancelAllBtn = (allowedToCancel && isGroup)
      ? `<button class="btn btn-sm btn-danger mb-cancel-btn"
           style="font-size:.78rem;padding:.25rem .65rem"
           data-ids="${slots.map(b => b.id).join(',')}"
           data-groupid="${first.groupId || ''}"
           data-label="${esc(first.reason || first.label || 'Booking')}"
           data-date="${first.date}">Cancel All Slots</button>`
      : '';

    // Single-booking cancel button
    const cancelSingleBtn = (allowedToCancel && !isGroup)
      ? `<button class="btn btn-sm btn-danger mb-cancel-btn"
           style="font-size:.78rem;padding:.25rem .65rem"
           data-ids="${first.id}"
           data-groupid=""
           data-label="${esc(first.reason || first.label || 'Booking')}"
           data-date="${first.date}">Cancel</button>`
      : '';

    return `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin-bottom:.5rem">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;flex-wrap:wrap;margin-bottom:${isGroup ? '.4rem' : '.2rem'}">
          <div style="font-weight:600;font-size:.95rem">${esc(venue ? venue.name : first.venueId)}</div>
          ${isGroup ? '' : _statusBadge(first.status)}
        </div>
        ${isGroup
          ? slots.map(b => _slotRow(b, venues[b.venueId], allowedToCancel)).join('')
          : `<div style="font-size:.85rem;color:var(--neutral)">${esc(_slotLabel(first.timeSlot))} &middot; ${esc(_courtLabel(first, venue))}</div>`
        }
        ${first.reason ? `<div style="font-size:.82rem;color:var(--neutral);margin-top:.2rem">${esc(first.reason)}</div>` : ''}
        ${(cancelAllBtn || cancelSingleBtn) ? `<div style="margin-top:.55rem;display:flex;gap:.4rem;flex-wrap:wrap">${cancelAllBtn}${cancelSingleBtn}</div>` : ''}
      </div>`;
  }

  // Group bookings by groupId, keeping singletons as-is
  function _groupSlots(bookings) {
    const groups = new Map(); // groupId → [booking]
    const singles = [];
    bookings.forEach(b => {
      if (b.groupId) {
        if (!groups.has(b.groupId)) groups.set(b.groupId, []);
        groups.get(b.groupId).push(b);
      } else {
        singles.push([b]);
      }
    });
    return [...singles, ...[...groups.values()]];
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

    const today  = toDateStr(new Date());
    const venues = _venueMap();

    const mine = DB.getBookings()
      .filter(b => b.requestedBy === user.uid && !b.deleted)
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

    // Active: upcoming date, pending or confirmed
    const active = mine.filter(b =>
      b.date >= today && (b.status === 'pending' || b.status === 'confirmed')
    );

    // History: past OR cancelled/rejected (at any date)
    const history = mine
      .filter(b => b.date < today || b.status === 'cancelled' || b.status === 'rejected')
      .sort((a, b) => a.date > b.date ? -1 : a.date < b.date ? 1 : 0); // newest first

    const activeGroups  = _groupSlots(active);
    const historyGroups = _groupSlots(history);

    if (mine.length === 0) {
      el.innerHTML = `<div class="empty-state"><p class="text-muted">You have no bookings yet.</p></div>`;
      return;
    }

    const activeHtml = activeGroups.length > 0
      ? activeGroups.map(g => _card(g, venues, true)).join('')
      : `<p style="font-size:.88rem;color:var(--neutral);margin-bottom:1rem">No upcoming bookings.</p>`;

    const historyHtml = historyGroups.length > 0
      ? `<details style="margin-top:1.25rem">
          <summary style="font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--neutral);cursor:pointer;user-select:none;padding:.25rem 0">
            History (${historyGroups.length})
          </summary>
          <div style="margin-top:.6rem">${historyGroups.map(g => _card(g, venues, false)).join('')}</div>
        </details>`
      : '';

    el.innerHTML = `
      <div style="font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--neutral);margin-bottom:.6rem">
        Upcoming (${activeGroups.length})
      </div>
      ${activeHtml}
      ${historyHtml}`;

    // ── Wire cancel buttons ───────────────────────────────────
    el.querySelectorAll('.mb-cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ids     = btn.dataset.ids.split(',').filter(Boolean);
        const groupId = btn.dataset.groupid;
        const label   = btn.dataset.label;
        const date    = btn.dataset.date;
        const isGroup = ids.length > 1;

        // Re-fetch to get latest status (data may have updated since render)
        const bookings = ids.map(id => DB.getBookings().find(b => b.id === id)).filter(Boolean);
        if (bookings.length === 0) { render(); return; }

        if (!bookingCancellationAllowed(bookings[0])) {
          toast('Cancellations are not permitted within 4 hours of the booking time.', 'error');
          return;
        }

        const msg = isGroup
          ? `Cancel all ${ids.length} slots in this group booking?\n\n"${label}" — from ${formatDate(date)}`
          : `Cancel this booking?\n\n"${label}" on ${formatDate(date)}`;
        if (!confirm(msg)) return;

        btn.disabled    = true;
        btn.textContent = 'Cancelling…';

        try {
          for (const b of bookings) {
            await DB.rejectBooking(b.id, 'cancelled');
          }
          // Notify venue/admin — non-critical
          const firstId = ids[0];
          const fn = firebase.functions().httpsCallable('notifyUserCancellation');
          fn(groupId ? { bookingId: firstId, groupId } : { bookingId: firstId }).catch(() => {});

          toast('Booking cancelled');
          render();
        } catch (err) {
          console.error('[MyBookings] cancel failed:', err);
          btn.disabled    = false;
          btn.textContent = isGroup ? 'Cancel All Slots' : 'Cancel';
          toast('Failed to cancel — please try again', 'error');
        }
      });
    });
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
