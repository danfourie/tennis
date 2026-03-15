/**
 * admin.js — Admin panel: venues, schools, closures, password
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
  }

  // ---- VENUES ----
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
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-secondary" data-venue-edit="${v.id}">Edit</button>
            <button class="btn btn-xs btn-danger" data-venue-delete="${v.id}">Del</button>
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
    document.getElementById('venueName').value = v ? v.name : '';
    document.getElementById('venueAddress').value = v ? (v.address || '') : '';
    document.getElementById('venueCourtCount').value = v ? (v.courts || 4) : 4;
    document.getElementById('venueEditId').value = v ? v.id : '';
    Modal.open('venueModal');
  }

  function saveVenue() {
    const name = document.getElementById('venueName').value.trim();
    if (!name) { toast('Venue name required', 'error'); return; }
    const id = document.getElementById('venueEditId').value;
    const venue = {
      id: id || uid(),
      name,
      address: document.getElementById('venueAddress').value.trim(),
      courts: parseInt(document.getElementById('venueCourtCount').value) || 4,
    };
    if (id) { DB.updateVenue(venue); toast('Venue updated', 'success'); }
    else { DB.addVenue(venue); toast('Venue added', 'success'); }
    Modal.close('venueModal');
    render();
    Calendar.refresh();
    Leagues.refresh();
    Tournaments.refresh();
  }

  function deleteVenue(id) {
    if (!confirm('Delete this venue? Bookings at this venue will remain but venue reference will be lost.')) return;
    DB.deleteVenue(id);
    render();
    Calendar.refresh();
    toast('Venue deleted');
  }

  // ---- SCHOOLS ----
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
            <div class="text-muted">${venue ? esc(venue.name) : 'No home venue'} · ${esc(s.contact || '')}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-xs btn-secondary" data-school-edit="${s.id}">Edit</button>
            <button class="btn btn-xs btn-danger" data-school-delete="${s.id}">Del</button>
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
    document.getElementById('schoolName').value = s ? s.name : '';
    document.getElementById('schoolContact').value = s ? (s.contact || '') : '';
    document.getElementById('schoolColor').value = s ? (s.color || '#3b82f6') : '#3b82f6';
    document.getElementById('schoolEditId').value = s ? s.id : '';

    const vSel = document.getElementById('schoolVenue');
    vSel.innerHTML = `<option value="">No home venue</option>` +
      venues.map(v => `<option value="${v.id}"${s && s.venueId === v.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
    Modal.open('schoolModal');
  }

  function saveSchool() {
    const name = document.getElementById('schoolName').value.trim();
    if (!name) { toast('School name required', 'error'); return; }
    const id = document.getElementById('schoolEditId').value;
    const school = {
      id: id || uid(),
      name,
      venueId: document.getElementById('schoolVenue').value || null,
      contact: document.getElementById('schoolContact').value.trim(),
      color: document.getElementById('schoolColor').value,
    };
    if (id) { DB.updateSchool(school); toast('School updated', 'success'); }
    else { DB.addSchool(school); toast('School added', 'success'); }
    Modal.close('schoolModal');
    render();
    Leagues.refresh();
  }

  function deleteSchool(id) {
    if (!confirm('Delete this school?')) return;
    DB.deleteSchool(id);
    render();
    Leagues.refresh();
    toast('School deleted');
  }

  // ---- CLOSURES ----
  function renderClosures() {
    const el = document.getElementById('closuresList');
    const closures = DB.getClosures();
    if (closures.length === 0) {
      el.innerHTML = `<p class="text-muted">No closures defined.</p>`;
      return;
    }
    el.innerHTML = `<div class="admin-list">` +
      closures.map(c => {
        const venue = DB.getVenues().find(v => v.id === c.venueId);
        const courtLabel = c.courtIndex !== null && c.courtIndex !== undefined && c.courtIndex !== ''
          ? ` · Court ${parseInt(c.courtIndex) + 1}` : '';
        const timeLabel = c.timeStart && c.timeEnd ? ` · ${c.timeStart}–${c.timeEnd}` : '';
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
        render();
        Calendar.refresh();
        toast('Closure removed');
      });
    });
  }

  function openClosureModal() {
    const venues = DB.getVenues();
    const vSel = document.getElementById('closureVenue');
    vSel.innerHTML = venues.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
    updateClosureCourtList();
    document.getElementById('closureStart').value = toDateStr(new Date());
    document.getElementById('closureEnd').value = toDateStr(new Date());
    document.getElementById('closureTimeStart').value = '';
    document.getElementById('closureTimeEnd').value = '';
    document.getElementById('closureReason').value = '';
    Modal.open('closureModal');
  }

  function updateClosureCourtList() {
    const venueId = document.getElementById('closureVenue').value;
    const venue = DB.getVenues().find(v => v.id === venueId);
    const sel = document.getElementById('closureCourt');
    sel.innerHTML = `<option value="">Entire Venue</option>`;
    if (venue) {
      for (let i = 0; i < (venue.courts || 0); i++) {
        sel.innerHTML += `<option value="${i}">Court ${i + 1}</option>`;
      }
    }
  }

  function saveClosure() {
    const venueId = document.getElementById('closureVenue').value;
    if (!venueId) { toast('Select a venue', 'error'); return; }
    const startDate = document.getElementById('closureStart').value;
    const endDate = document.getElementById('closureEnd').value;
    if (!startDate || !endDate) { toast('Dates required', 'error'); return; }

    const courtVal = document.getElementById('closureCourt').value;
    DB.addClosure({
      venueId,
      courtIndex: courtVal !== '' ? parseInt(courtVal) : null,
      startDate,
      endDate,
      timeStart: document.getElementById('closureTimeStart').value || null,
      timeEnd: document.getElementById('closureTimeEnd').value || null,
      reason: document.getElementById('closureReason').value.trim(),
    });
    Modal.close('closureModal');
    render();
    Calendar.refresh();
    toast('Closure added', 'success');
  }

  // ---- PASSWORD (via Firebase Auth) ----
  async function changePassword() {
    const np = document.getElementById('newPassword').value;
    if (!np || np.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
    const btn = document.getElementById('changePasswordBtn');
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      await Auth.changePassword(np);
      document.getElementById('newPassword').value = '';
      toast('Password updated ✓', 'success');
    } catch (err) {
      // Firebase requires recent sign-in for sensitive ops
      if (err.code === 'auth/requires-recent-login') {
        toast('Please log out and sign in again before changing your password', 'error');
      } else {
        toast('Error: ' + err.message, 'error');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Update';
    }
  }

  return { init, refresh };
})();
