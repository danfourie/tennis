/**
 * admin.js — Admin panel: venues, schools, closures, users, pending requests, audit log
 */

const Admin = (() => {

  function init() {
    document.getElementById('addVenueBtn').addEventListener('click', () => openVenueModal());
    document.getElementById('venueSubmitBtn').addEventListener('click', saveVenue);

    document.getElementById('addSchoolBtn').addEventListener('click', () => openSchoolModal());
    document.getElementById('schoolSubmitBtn').addEventListener('click', saveSchool);

    document.getElementById('addClosureBtn').addEventListener('click', () => openClosureModal());
    document.getElementById('closureSubmitBtn').addEventListener('click', saveClosure);
    document.getElementById('closureVenue').addEventListener('change', updateClosureCourtList);

    document.getElementById('changePasswordBtn').addEventListener('click', changePassword);

    render();
  }

  function refresh() { render(); }

  function render() {
    renderVenues();
    renderSchools();
    renderClosures();
    renderPendingBookings();
    renderUsers();       // async
    renderAuditLog();    // async
  }

  // ════════════════════════════════════════════════════════════
  // PENDING BOOKING REQUESTS
  // ════════════════════════════════════════════════════════════
  function renderPendingBookings() {
    const el = document.getElementById('pendingList');
    if (!el) return;

    const pending = DB.getPendingBookings();
    if (pending.length === 0) {
      el.innerHTML = `<p class="text-muted">No pending requests.</p>`;
      return;
    }

    el.innerHTML = `<div class="admin-list">` +
      pending.map(b => {
        const venue = DB.getVenues().find(v => v.id === b.venueId);
        return `<div class="admin-list-item">
          <div>
            <strong>${esc(b.label || b.type || 'Booking')}</strong>
            <div class="text-muted">
              ${venue ? esc(venue.name) : '?'} · Court ${(b.courtIndex || 0) + 1}
              · ${b.date ? formatDate(b.date) : '?'} · ${b.timeSlot || '?'}
            </div>
            <div class="text-muted">Requested by: <em>${esc(b.requestedByName || 'Unknown')}</em></div>
            ${b.notes ? `<div class="text-muted">${esc(b.notes)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-primary" data-approve="${b.id}">Approve</button>
            <button class="btn btn-xs btn-danger"  data-reject="${b.id}">Reject</button>
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', () => {
        const booking = DB.getBookings().find(b => b.id === btn.dataset.approve);
        DB.approveBooking(btn.dataset.approve);
        DB.writeAudit(
          'booking_approved', 'booking',
          `Approved request by ${booking ? esc(booking.requestedByName || 'user') : 'user'}: ${booking ? esc(booking.label || '') : ''}`,
          btn.dataset.approve, booking ? booking.label : ''
        );
        Calendar.refresh();
        render();
        toast('Booking approved ✓', 'success');
      });
    });

    el.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', () => {
        const booking = DB.getBookings().find(b => b.id === btn.dataset.reject);
        DB.rejectBooking(btn.dataset.reject);
        DB.writeAudit(
          'booking_rejected', 'booking',
          `Rejected request by ${booking ? esc(booking.requestedByName || 'user') : 'user'}: ${booking ? esc(booking.label || '') : ''}`,
          btn.dataset.reject, booking ? booking.label : ''
        );
        Calendar.refresh();
        render();
        toast('Request rejected');
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // USERS MANAGEMENT
  // ════════════════════════════════════════════════════════════
  async function renderUsers() {
    const el = document.getElementById('usersList');
    if (!el) return;

    el.innerHTML = `<p class="text-muted">Loading users…</p>`;
    const users = await DB.loadUsers();

    if (users.length === 0) {
      el.innerHTML = `<p class="text-muted">No registered users yet.</p>`;
      return;
    }

    const currentUid = Auth.getUser() ? Auth.getUser().uid : null;
    const schools    = DB.getSchools();

    el.innerHTML = `<div class="admin-list">` +
      users.map(u => {
        const school  = schools.find(s => s.id === u.schoolId);
        const isSelf  = u.uid === currentUid;
        const roleIcon = u.role === 'master' ? '🔑' : '👤';

        return `<div class="admin-list-item">
          <div>
            <strong>${roleIcon} ${esc(u.displayName || u.email)}</strong>
            ${isSelf ? '<span class="badge badge-gray" style="font-size:.7rem;margin-left:.3rem">You</span>' : ''}
            <div class="text-muted">${esc(u.email)}</div>
            <div class="text-muted">
              <span class="role-badge ${u.role === 'master' ? 'master' : 'user'}">${u.role}</span>
              ${school ? ` · ${esc(school.name)}` : ''}
              ${u.createdAt ? ` · Joined ${new Date(u.createdAt).toLocaleDateString('en-ZA',{day:'numeric',month:'short',year:'numeric'})}` : ''}
            </div>
          </div>
          <div class="item-actions">
            <select class="role-select" data-user-uid="${u.uid}" data-current-role="${u.role}" style="padding:.2rem .4rem;border-radius:6px;border:1.5px solid var(--border);font-size:.8rem">
              <option value="user"  ${u.role === 'user'   ? 'selected' : ''}>User</option>
              <option value="master"${u.role === 'master' ? 'selected' : ''}>Master</option>
            </select>
            ${!isSelf ? `<button class="btn btn-xs btn-danger" data-user-delete="${u.uid}">Remove</button>` : ''}
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('.role-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const userUid  = sel.dataset.userUid;
        const oldRole  = sel.dataset.currentRole;
        const newRole  = sel.value;
        const user     = DB.getUsers().find(u => u.uid === userUid);
        if (!user || oldRole === newRole) return;
        DB.updateUser({ ...user, role: newRole });
        DB.writeAudit(
          'user_role_changed', 'user',
          `Role changed for ${esc(user.displayName || user.email)}: ${oldRole} → ${newRole}`,
          userUid, user.displayName || user.email
        );
        sel.dataset.currentRole = newRole;
        toast(`Role updated to "${newRole}"`, 'success');
        renderUsers();
      });
    });

    el.querySelectorAll('[data-user-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        const userUid = btn.dataset.userDelete;
        const user    = DB.getUsers().find(u => u.uid === userUid);
        if (!confirm(`Remove ${user ? (user.displayName || user.email) : 'this user'}? They will lose access.`)) return;
        DB.deleteUserProfile(userUid);
        DB.writeAudit(
          'user_removed', 'user',
          `User profile removed: ${user ? esc(user.displayName || user.email) : userUid}`,
          userUid, user ? (user.displayName || user.email) : userUid
        );
        toast('User removed');
        renderUsers();
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // AUDIT LOG
  // ════════════════════════════════════════════════════════════
  async function renderAuditLog() {
    const el = document.getElementById('auditList');
    if (!el) return;

    el.innerHTML = `<p class="text-muted">Loading…</p>`;
    const entries = await DB.loadAuditLog(100);

    if (entries.length === 0) {
      el.innerHTML = `<p class="text-muted">No activity recorded yet.</p>`;
      return;
    }

    const catIcon = { booking: '📅', league: '🏆', tournament: '🏅', admin: '⚙️', user: '👤' };

    el.innerHTML = `<div class="audit-table-wrap"><table class="audit-table">
      <thead><tr><th>When</th><th>Who</th><th>What happened</th></tr></thead>
      <tbody>` +
      entries.map(e => {
        const when = e.at
          ? new Date(e.at).toLocaleString('en-ZA', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
          : '—';
        const icon = catIcon[e.category] || '📋';
        return `<tr>
          <td class="audit-when">${when}</td>
          <td class="audit-who">${esc(e.by || '?')}</td>
          <td>${icon} ${esc(e.description || e.action || '?')}</td>
        </tr>`;
      }).join('') +
      `</tbody></table></div>
      <button class="btn btn-xs btn-secondary" id="refreshAuditBtn" style="margin-top:.5rem">↺ Refresh</button>`;

    document.getElementById('refreshAuditBtn').addEventListener('click', renderAuditLog);
  }

  // ════════════════════════════════════════════════════════════
  // VENUES
  // ════════════════════════════════════════════════════════════
  function renderVenues() {
    const el = document.getElementById('venuesList');
    const venues = DB.getVenues();
    if (venues.length === 0) {
      el.innerHTML = `<p class="text-muted">No venues yet.</p>`;
      return;
    }
    el.innerHTML = `<div class="admin-list">` +
      venues.map(v => `
        <div class="admin-list-item">
          <div>
            <strong>${esc(v.name)}</strong>
            <div class="text-muted">${v.courts || 0} courts · ${esc(v.address || '')}</div>
            <div class="text-muted">${v.email ? esc(v.email) : ''}${v.email && v.phone ? ' · ' : ''}${v.phone ? esc(v.phone) : ''}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-secondary" data-venue-edit="${v.id}">Edit</button>
            <button class="btn btn-xs btn-danger"    data-venue-delete="${v.id}">Del</button>
          </div>
        </div>`).join('') +
      `</div>`;

    el.querySelectorAll('[data-venue-edit]').forEach(btn => {
      btn.addEventListener('click', () => openVenueModal(btn.dataset.venueEdit));
    });
    el.querySelectorAll('[data-venue-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteVenue(btn.dataset.venueDelete));
    });
  }

  function openVenueModal(id) {
    const v = id ? DB.getVenues().find(x => x.id === id) : null;
    document.getElementById('venueModalTitle').textContent = v ? 'Edit Venue' : 'Add Venue';
    document.getElementById('venueName').value             = v ? v.name : '';
    document.getElementById('venueAddress').value          = v ? (v.address || '') : '';
    document.getElementById('venueEmail').value            = v ? (v.email  || '') : '';
    document.getElementById('venuePhone').value            = v ? (v.phone  || '') : '';
    document.getElementById('venueCourtCount').value       = v ? (v.courts || 4) : 4;
    document.getElementById('venueEditId').value           = v ? v.id : '';
    Modal.open('venueModal');
  }

  function saveVenue() {
    const name  = document.getElementById('venueName').value.trim();
    const phone = document.getElementById('venuePhone').value.trim();
    if (!name) { toast('Venue name required', 'error'); return; }
    if (phone && !/^0\d{9}$/.test(phone)) {
      toast('Phone must be 10 digits starting with 0', 'error'); return;
    }
    const id = document.getElementById('venueEditId').value;
    const venue = {
      id: id || uid(),
      name,
      address: document.getElementById('venueAddress').value.trim(),
      email:   document.getElementById('venueEmail').value.trim(),
      phone,
      courts:  parseInt(document.getElementById('venueCourtCount').value) || 4,
    };
    if (id) {
      DB.updateVenue(venue);
      DB.writeAudit('venue_updated', 'admin', `Venue updated: ${name}`, id, name);
      toast('Venue updated', 'success');
    } else {
      DB.addVenue(venue);
      DB.writeAudit('venue_added', 'admin', `Venue added: ${name}`, venue.id, name);
      toast('Venue added', 'success');
    }
    Modal.close('venueModal');
    render();
    Calendar.refresh();
    Leagues.refresh();
    Tournaments.refresh();
  }

  function deleteVenue(id) {
    const venue = DB.getVenues().find(v => v.id === id);
    if (!confirm('Delete this venue? Bookings at this venue will remain but venue reference will be lost.')) return;
    DB.deleteVenue(id);
    DB.writeAudit('venue_deleted', 'admin', `Venue deleted: ${venue ? venue.name : id}`, id, venue ? venue.name : id);
    render();
    Calendar.refresh();
    toast('Venue deleted');
  }

  // ════════════════════════════════════════════════════════════
  // SCHOOLS
  // ════════════════════════════════════════════════════════════
  function renderSchools() {
    const el = document.getElementById('schoolsList');
    const schools = DB.getSchools();
    if (schools.length === 0) {
      el.innerHTML = `<p class="text-muted">No schools yet.</p>`;
      return;
    }
    el.innerHTML = `<div class="admin-list">` +
      schools.map(s => {
        const venue = DB.getVenues().find(v => v.id === s.venueId);
        return `<div class="admin-list-item">
          <div>
            <span class="color-dot" style="background:${s.color}"></span>
            <strong>${esc(s.name)}</strong>
            <div class="text-muted">${venue ? esc(venue.name) : 'No home venue'}${s.team ? ' · ' + esc(s.team) : ''}</div>
            <div class="text-muted">${s.contact ? esc(s.contact) : ''}${s.email ? ' · ' + esc(s.email) : ''}${s.phone ? ' · ' + esc(s.phone) : ''}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-secondary" data-school-edit="${s.id}">Edit</button>
            <button class="btn btn-xs btn-danger"    data-school-delete="${s.id}">Del</button>
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('[data-school-edit]').forEach(btn => {
      btn.addEventListener('click', () => openSchoolModal(btn.dataset.schoolEdit));
    });
    el.querySelectorAll('[data-school-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteSchool(btn.dataset.schoolDelete));
    });
  }

  function openSchoolModal(id) {
    const s = id ? DB.getSchools().find(x => x.id === id) : null;
    const venues = DB.getVenues();
    document.getElementById('schoolModalTitle').textContent = s ? 'Edit School' : 'Add School';
    document.getElementById('schoolName').value             = s ? s.name : '';
    document.getElementById('schoolTeam').value             = s ? (s.team    || '') : '';
    document.getElementById('schoolContact').value          = s ? (s.contact || '') : '';
    document.getElementById('schoolEmail').value            = s ? (s.email   || '') : '';
    document.getElementById('schoolPhone').value            = s ? (s.phone   || '') : '';
    document.getElementById('schoolColor').value            = s ? (s.color   || '#3b82f6') : '#3b82f6';
    document.getElementById('schoolEditId').value           = s ? s.id : '';
    const vSel = document.getElementById('schoolVenue');
    vSel.innerHTML = `<option value="">No home venue</option>` +
      venues.map(v => `<option value="${v.id}"${s && s.venueId === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
    Modal.open('schoolModal');
  }

  function saveSchool() {
    const name  = document.getElementById('schoolName').value.trim();
    const phone = document.getElementById('schoolPhone').value.trim();
    if (!name) { toast('School name required', 'error'); return; }
    if (phone && !/^0\d{9}$/.test(phone)) {
      toast('Phone must be 10 digits starting with 0', 'error'); return;
    }
    const id = document.getElementById('schoolEditId').value;
    const school = {
      id:      id || uid(),
      name,
      team:    document.getElementById('schoolTeam').value.trim(),
      venueId: document.getElementById('schoolVenue').value || null,
      contact: document.getElementById('schoolContact').value.trim(),
      email:   document.getElementById('schoolEmail').value.trim(),
      phone,
      color:   document.getElementById('schoolColor').value,
    };
    if (id) {
      DB.updateSchool(school);
      DB.writeAudit('school_updated', 'admin', `School updated: ${name}`, id, name);
      toast('School updated', 'success');
    } else {
      DB.addSchool(school);
      DB.writeAudit('school_added', 'admin', `School added: ${name}`, school.id, name);
      toast('School added', 'success');
    }
    Modal.close('schoolModal');
    render();
    Leagues.refresh();
  }

  function deleteSchool(id) {
    const school = DB.getSchools().find(s => s.id === id);
    if (!confirm('Delete this school?')) return;
    DB.deleteSchool(id);
    DB.writeAudit('school_deleted', 'admin', `School deleted: ${school ? school.name : id}`, id, school ? school.name : id);
    render();
    Leagues.refresh();
    toast('School deleted');
  }

  // ════════════════════════════════════════════════════════════
  // CLOSURES
  // ════════════════════════════════════════════════════════════
  function renderClosures() {
    const el = document.getElementById('closuresList');
    const closures = DB.getClosures();
    if (closures.length === 0) {
      el.innerHTML = `<p class="text-muted">No closures defined.</p>`;
      return;
    }
    el.innerHTML = `<div class="admin-list">` +
      closures.map(c => {
        const venue     = DB.getVenues().find(v => v.id === c.venueId);
        const courtLabel = c.courtIndex !== null && c.courtIndex !== undefined && c.courtIndex !== ''
          ? ` · Court ${parseInt(c.courtIndex) + 1}` : '';
        const timeLabel  = c.timeStart && c.timeEnd ? ` · ${c.timeStart}–${c.timeEnd}` : '';
        return `<div class="admin-list-item">
          <div>
            <strong>${venue ? esc(venue.name) : 'Unknown'}${courtLabel}</strong>
            <div class="text-muted">${formatDate(c.startDate)} → ${formatDate(c.endDate)}${timeLabel}</div>
            ${c.reason ? `<div class="text-muted">${esc(c.reason)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-danger" data-closure-delete="${c.id}">Del</button>
          </div>
        </div>`;
      }).join('') +
      `</div>`;

    el.querySelectorAll('[data-closure-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        DB.deleteClosure(btn.dataset.closureDelete);
        DB.writeAudit('closure_deleted', 'admin', `Court closure removed`, btn.dataset.closureDelete);
        render();
        Calendar.refresh();
        toast('Closure removed');
      });
    });
  }

  function openClosureModal() {
    const venues = DB.getVenues();
    const vSel   = document.getElementById('closureVenue');
    vSel.innerHTML = venues.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
    updateClosureCourtList();
    document.getElementById('closureStart').value     = toDateStr(new Date());
    document.getElementById('closureEnd').value       = toDateStr(new Date());
    document.getElementById('closureTimeStart').value = '';
    document.getElementById('closureTimeEnd').value   = '';
    document.getElementById('closureReason').value    = '';
    Modal.open('closureModal');
  }

  function updateClosureCourtList() {
    const venueId = document.getElementById('closureVenue').value;
    const venue   = DB.getVenues().find(v => v.id === venueId);
    const sel     = document.getElementById('closureCourt');
    sel.innerHTML = `<option value="">Entire Venue</option>`;
    if (venue) {
      for (let i = 0; i < (venue.courts || 0); i++) {
        sel.innerHTML += `<option value="${i}">Court ${i + 1}</option>`;
      }
    }
  }

  function saveClosure() {
    const venueId   = document.getElementById('closureVenue').value;
    if (!venueId) { toast('Select a venue', 'error'); return; }
    const startDate = document.getElementById('closureStart').value;
    const endDate   = document.getElementById('closureEnd').value;
    if (!startDate || !endDate) { toast('Dates required', 'error'); return; }
    const courtVal  = document.getElementById('closureCourt').value;
    const venue     = DB.getVenues().find(v => v.id === venueId);
    const reason    = document.getElementById('closureReason').value.trim();

    DB.addClosure({
      venueId,
      courtIndex: courtVal !== '' ? parseInt(courtVal) : null,
      startDate,
      endDate,
      timeStart: document.getElementById('closureTimeStart').value || null,
      timeEnd:   document.getElementById('closureTimeEnd').value   || null,
      reason,
    });
    DB.writeAudit(
      'closure_added', 'admin',
      `Closure: ${venue ? venue.name : venueId}${courtVal !== '' ? ` Court ${parseInt(courtVal)+1}` : ''} ${startDate}–${endDate}${reason ? ` (${reason})` : ''}`,
      venueId, venue ? venue.name : venueId
    );
    Modal.close('closureModal');
    render();
    Calendar.refresh();
    toast('Closure added', 'success');
  }

  // ════════════════════════════════════════════════════════════
  // PASSWORD (via Firebase Auth)
  // ════════════════════════════════════════════════════════════
  async function changePassword() {
    const np  = document.getElementById('newPassword').value;
    if (!np || np.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
    const btn = document.getElementById('changePasswordBtn');
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      await Auth.changePassword(np);
      document.getElementById('newPassword').value = '';
      DB.writeAudit('password_changed', 'admin', 'Master password changed');
      toast('Password updated ✓', 'success');
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') {
        toast('Please log out and sign in again before changing your password', 'error');
      } else {
        toast('Error: ' + err.message, 'error');
      }
    } finally {
      btn.disabled = false; btn.textContent = 'Update';
    }
  }

  return { init, refresh };
})();
