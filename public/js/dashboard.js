const user = getUser();
if (!user || !getToken()) {
  window.location.href = '/index.html';
}

const ROLE_LABEL = {
  admin: 'Admin',
  production_manager: 'Production Manager',
  engineer: 'Engineer',
  customer: 'Customer',
};

document.getElementById('whoami').textContent = `${user.name} · ${ROLE_LABEL[user.role] || user.role}`;
document.getElementById('logoutBtn').addEventListener('click', () => {
  clearSession();
  window.location.href = '/index.html';
});

function toast(msg) {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function badgeClass(status) {
  return 'badge badge-' + status.replace(/\s/g, '');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Admin: roles panel ----------
async function initRolesPanel() {
  if (user.role !== 'admin') return;
  document.getElementById('rolesPanel').style.display = 'block';
  await loadRoles();

  document.getElementById('createRoleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newRoleName').value.trim();
    const description = document.getElementById('newRoleDesc').value.trim();
    try {
      await api('/roles', { method: 'POST', body: { name, description } });
      toast('Role created.');
      e.target.reset();
      await refreshRoleViews();
    } catch (err) {
      toast('Error: ' + err.message);
    }
  });
}

// Mirrors BUILT_IN_ROLES in src/routes/roles.js — these can't be edited or deleted.
const BUILT_IN_ROLES = ['admin', 'production_manager', 'engineer', 'customer'];

async function loadRoles() {
  const listEl = document.getElementById('rolesList');
  try {
    const roles = await api('/roles');
    listEl.innerHTML = roles
      .map((r) => BUILT_IN_ROLES.includes(r.name)
        ? `<span class="role-chip" title="Built-in role">${escapeHtml(r.name)}</span>`
        : `<span class="role-chip" data-role-id="${r.id}" title="${escapeHtml(r.description || '')}">
            ${escapeHtml(r.name)}
            <button type="button" class="chip-remove-btn edit-role-btn" title="Edit role">✎</button>
            <button type="button" class="chip-remove-btn delete-role-btn" title="Delete role">×</button>
          </span>`)
      .join('') || '<span class="empty-state">No roles yet.</span>';

    const byId = new Map(roles.map((r) => [String(r.id), r]));
    listEl.querySelectorAll('.edit-role-btn').forEach((btn) => {
      btn.addEventListener('click', () => openEditRoleModal(byId.get(btn.closest('.role-chip').dataset.roleId)));
    });
    listEl.querySelectorAll('.delete-role-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteRole(byId.get(btn.closest('.role-chip').dataset.roleId)));
    });
    return roles;
  } catch (err) {
    toast('Could not load roles: ' + err.message);
    return [];
  }
}

// Every dropdown/list that shows roles needs refreshing after a role change.
async function refreshRoleViews() {
  await loadRoles();
  await populateNewUserRoleSelect();
  await populateUserRoleFilter();
  await loadUsers();
}

async function deleteRole(r) {
  if (!confirm(`Delete the role "${r.name}"? This cannot be undone.`)) return;
  try {
    await api(`/roles/${r.id}`, { method: 'DELETE' });
    toast(`Role "${r.name}" deleted.`);
    await refreshRoleViews();
  } catch (err) {
    toast('Error: ' + err.message);
  }
}

function openEditRoleModal(r) {
  document.getElementById('modalTitle').textContent = `Edit Role — ${r.name}`;
  document.getElementById('modalBody').innerHTML = `
    <form id="editRoleForm">
      <label>Role Name</label>
      <input type="text" id="editRoleName" required value="${escapeHtml(r.name)}" />
      <label>Description</label>
      <input type="text" id="editRoleDesc" value="${escapeHtml(r.description || '')}" />
      <button class="btn-primary" type="submit">Save Changes</button>
    </form>`;
  overlay.classList.add('open');

  document.getElementById('editRoleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('editRoleName').value.trim(),
      description: document.getElementById('editRoleDesc').value.trim(),
    };
    try {
      const res = await api(`/roles/${r.id}`, { method: 'PUT', body });
      toast(`Role updated to "${res.name}".`);
      overlay.classList.remove('open');
      await refreshRoleViews();
    } catch (err) {
      toast('Error: ' + err.message);
    }
  });
}

async function populateNewUserRoleSelect() {
  const sel = document.getElementById('newUserRole');
  try {
    const roles = await api('/roles');
    // Production Manager can only ever create customer accounts — the
    // dropdown only shows that option so the 403 from the backend is never
    // actually hit in normal use, it's just belt-and-suspenders there.
    const visibleRoles = user.role === 'production_manager'
      ? roles.filter((r) => r.name === 'customer')
      : roles;
    sel.innerHTML = '<option value="">Select role…</option>' +
      visibleRoles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
    if (user.role === 'production_manager' && visibleRoles.length === 1) {
      sel.value = visibleRoles[0].id;
    }
  } catch (err) {
    toast('Could not load roles: ' + err.message);
  }
}

// ---------- Admin / Production Manager: create user panel ----------
function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function initCreateUserPanel() {
  if (user.role !== 'admin' && user.role !== 'production_manager') return;
  document.getElementById('createUserPanel').style.display = 'block';
  if (user.role === 'production_manager') {
    document.querySelector('#createUserPanel h2').textContent = 'Create Customer Account';
  }
  await populateNewUserRoleSelect();

  const passwordInput = document.getElementById('newUserPassword');
  const toggleBtn = document.getElementById('toggleNewUserPassword');
  const generateBtn = document.getElementById('generateNewUserPassword');
  const eyeOpenPaths = toggleBtn.querySelectorAll('.eye-open');
  const eyeClosedPaths = toggleBtn.querySelectorAll('.eye-closed');

  function setPasswordVisible(visible) {
    passwordInput.type = visible ? 'text' : 'password';
    eyeOpenPaths.forEach((p) => { p.style.display = visible ? 'none' : ''; });
    eyeClosedPaths.forEach((p) => { p.style.display = visible ? '' : 'none'; });
    toggleBtn.title = visible ? 'Hide password' : 'Show password';
    toggleBtn.setAttribute('aria-label', toggleBtn.title);
  }

  toggleBtn.addEventListener('click', () => {
    setPasswordVisible(passwordInput.type === 'password');
  });

  generateBtn.addEventListener('click', () => {
    passwordInput.value = generatePassword();
    setPasswordVisible(true);
  });

  document.getElementById('createUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('newUserName').value.trim(),
      email: document.getElementById('newUserEmail').value.trim(),
      password: document.getElementById('newUserPassword').value,
      roleId: document.getElementById('newUserRole').value,
    };
    if (!body.roleId) { toast('Please select a role'); return; }
    try {
      const res = await api('/users', { method: 'POST', body });
      toast(res.emailSent
        ? `Account created for ${res.email} (${res.role}). Login details emailed to them.`
        : `Account created for ${res.email} (${res.role}), but the welcome email could not be sent — share the password manually.`);
      e.target.reset();
      setPasswordVisible(false);
      if (user.role === 'admin') loadUsers();
    } catch (err) {
      toast('Error: ' + err.message);
    }
  });
}

// ---------- Admin: users panel (filter by role, edit, delete) ----------
let allRoles = [];

async function populateUserRoleFilter() {
  const sel = document.getElementById('userRoleFilter');
  const current = sel.value;
  try {
    allRoles = await api('/roles');
    sel.innerHTML = '<option value="">All roles</option>' +
      allRoles.map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(ROLE_LABEL[r.name] || r.name)}</option>`).join('');
    sel.value = current;
  } catch (err) {
    toast('Could not load roles: ' + err.message);
  }
}

async function initUsersPanel() {
  if (user.role !== 'admin') return;
  document.getElementById('usersPanel').style.display = 'block';
  await populateUserRoleFilter();
  document.getElementById('userRoleFilter').addEventListener('change', loadUsers);
  await loadUsers();
}

async function loadUsers() {
  const listEl = document.getElementById('usersList');
  const role = document.getElementById('userRoleFilter').value;
  try {
    const users = await api('/users' + (role ? `?role=${encodeURIComponent(role)}` : ''));
    if (!users.length) {
      listEl.innerHTML = '<div class="empty-state">No users with this role.</div>';
      return;
    }
    listEl.innerHTML = `
      <div class="table-wrap">
        <table class="users-table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th></th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr data-id="${u.id}">
                <td>${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.email)}</td>
                <td><span class="role-chip">${escapeHtml(ROLE_LABEL[u.role] || u.role)}</span></td>
                <td>${escapeHtml(String(u.created_at).slice(0, 10))}</td>
                <td class="row-actions">
                  <button type="button" class="btn-secondary edit-user-btn">Edit</button>
                  ${u.id === user.id ? '' : '<button type="button" class="btn-secondary btn-danger delete-user-btn">Delete</button>'}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    const byId = new Map(users.map((u) => [String(u.id), u]));
    listEl.querySelectorAll('.edit-user-btn').forEach((btn) => {
      btn.addEventListener('click', () => openEditUserModal(byId.get(btn.closest('tr').dataset.id)));
    });
    listEl.querySelectorAll('.delete-user-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteUser(byId.get(btn.closest('tr').dataset.id)));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Failed to load users: ${escapeHtml(err.message)}</div>`;
  }
}

async function deleteUser(u) {
  if (!confirm(`Delete ${u.name} (${u.email})? This cannot be undone.`)) return;
  try {
    await api(`/users/${u.id}`, { method: 'DELETE' });
    toast(`${u.name} deleted.`);
    loadUsers();
  } catch (err) {
    toast('Error: ' + err.message);
  }
}

function openEditUserModal(u) {
  const isSelf = u.id === user.id;
  document.getElementById('modalTitle').textContent = `Edit User — ${u.name}`;
  document.getElementById('modalBody').innerHTML = `
    <form id="editUserForm">
      <label>Full Name</label>
      <input type="text" id="editUserName" required value="${escapeHtml(u.name)}" />
      <label>Email</label>
      <input type="email" id="editUserEmail" required value="${escapeHtml(u.email)}" />
      <label>Role</label>
      <select id="editUserRole" ${isSelf ? 'disabled title="You cannot change your own role"' : ''}>
        ${allRoles.map((r) => `<option value="${r.id}" ${r.id === u.roleId ? 'selected' : ''}>${escapeHtml(ROLE_LABEL[r.name] || r.name)}</option>`).join('')}
      </select>
      <label>New Password (leave blank to keep current)</label>
      <div class="inline-form">
        <input type="text" id="editUserPassword" minlength="6" autocomplete="new-password" placeholder="At least 6 characters" />
        <button type="button" class="btn-secondary" id="editUserGenerate">Generate</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-top:4px;">If you set a new password, it will be emailed to the user.</div>
      <button class="btn-primary" type="submit">Save Changes</button>
    </form>`;
  overlay.classList.add('open');

  document.getElementById('editUserGenerate').addEventListener('click', () => {
    document.getElementById('editUserPassword').value = generatePassword();
  });

  document.getElementById('editUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('editUserName').value.trim(),
      email: document.getElementById('editUserEmail').value.trim(),
      roleId: Number(document.getElementById('editUserRole').value),
    };
    const password = document.getElementById('editUserPassword').value;
    if (password) body.password = password;
    try {
      const res = await api(`/users/${u.id}`, { method: 'PUT', body });
      toast(!res.passwordChanged
        ? `${res.name} updated.`
        : res.emailSent
          ? `${res.name} updated. New password emailed to ${res.email}.`
          : `${res.name} updated, but the password email could not be sent — share the new password manually.`);
      if (isSelf) {
        localStorage.setItem('jtp_user', JSON.stringify({ ...user, name: res.name, email: res.email }));
        document.getElementById('whoami').textContent = `${res.name} · ${ROLE_LABEL[user.role] || user.role}`;
      }
      overlay.classList.remove('open');
      loadUsers();
    } catch (err) {
      toast('Error: ' + err.message);
    }
  });
}

// ---------- Admin / Production Manager: create job form ----------
function wireCustomerAutocomplete() {
  const input = document.getElementById('jobCustomerInput');
  const hidden = document.getElementById('jobCustomerId');
  const list = document.getElementById('jobCustomerList');
  let debounceTimer = null;

  function closeList() { list.style.display = 'none'; list.innerHTML = ''; }

  input.addEventListener('input', () => {
    hidden.value = ''; // typing again invalidates any previous selection
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 2) { closeList(); return; }
    debounceTimer = setTimeout(async () => {
      try {
        const matches = await api(`/users/search?role=customer&q=${encodeURIComponent(q)}`);
        if (!matches.length) {
          list.innerHTML = '<div class="autocomplete-item empty">No matching customers</div>';
          list.style.display = 'block';
          return;
        }
        list.innerHTML = matches.map((m) =>
          `<div class="autocomplete-item" data-id="${m.id}" data-email="${escapeHtml(m.email)}" data-name="${escapeHtml(m.name)}">
            <b>${escapeHtml(m.name)}</b><br><span>${escapeHtml(m.email)}</span>
          </div>`
        ).join('');
        list.style.display = 'block';
      } catch (err) {
        toast('Customer search failed: ' + err.message);
      }
    }, 250);
  });

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.autocomplete-item[data-id]');
    if (!item) return;
    hidden.value = item.dataset.id;
    input.value = item.dataset.email; // show the selected email in the box
    closeList();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete-wrap')) closeList();
  });
}

// ---------- Materials repeater (create job form) ----------
function addMaterialRow(material = '', quantity = '') {
  const list = document.getElementById('materialsList');
  const row = document.createElement('div');
  row.className = 'material-row';
  row.innerHTML = `
    <input type="text" class="pdMaterial" placeholder="e.g. Stainless Steel 304" value="${escapeHtml(material)}" />
    <input type="text" class="pdQuantity" placeholder="e.g. 500 units" value="${escapeHtml(quantity)}" />
    <button type="button" class="btn-remove" title="Remove">×</button>
  `;
  row.querySelector('.btn-remove').addEventListener('click', () => {
    row.remove();
    if (!list.children.length) addMaterialRow();
  });
  list.appendChild(row);
}

function getMaterialsFromForm() {
  return Array.from(document.querySelectorAll('#materialsList .material-row')).map((row) => ({
    material: row.querySelector('.pdMaterial').value.trim(),
    quantity: row.querySelector('.pdQuantity').value.trim(),
  })).filter((m) => m.material || m.quantity);
}

async function initCreateJobPanel() {
  if (user.role !== 'admin' && user.role !== 'production_manager') return;
  document.getElementById('createJobPanel').style.display = 'block';
  wireCustomerAutocomplete();

  addMaterialRow();
  document.getElementById('addMaterialBtn').addEventListener('click', () => addMaterialRow());

  try {
    const engineers = await api('/users?role=engineer');
    document.getElementById('jobEngineerIds').innerHTML = engineers.length
      ? engineers.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.email)})</option>`).join('')
      : '<option value="" disabled>No engineers registered yet</option>';
  } catch (err) {
    toast('Could not load engineers: ' + err.message);
  }

  if (user.role === 'admin') {
    document.getElementById('jobPmField').style.display = 'block';
    try {
      const pms = await api('/users?role=production_manager');
      document.getElementById('jobPmSelect').innerHTML = '<option value="">Unassigned</option>' +
        pms.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.email)})</option>`).join('');
    } catch (err) {
      toast('Could not load production managers: ' + err.message);
    }
  }

  document.getElementById('createJobForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const customerId = document.getElementById('jobCustomerId').value;
    if (!customerId) { toast('Type a customer email and select a match from the dropdown'); return; }
    const pmSelect = document.getElementById('jobPmSelect');
    const body = {
      title: document.getElementById('jobTitle').value.trim(),
      customerId,
      description: document.getElementById('jobDescription').value.trim(),
      productionDetails: {
        materials: getMaterialsFromForm(),
        priority: document.getElementById('pdPriority').value,
        deadline: document.getElementById('pdDeadline').value,
        specifications: document.getElementById('pdSpecs').value.trim(),
      },
      engineerIds: Array.from(document.getElementById('jobEngineerIds').selectedOptions).map((o) => o.value).filter(Boolean),
      pmId: user.role === 'admin' ? (pmSelect.value || null) : undefined,
    };
    try {
      const res = await api('/jobs', { method: 'POST', body });

      const files = Array.from(document.getElementById('jobDocuments').files || []);
      let uploadFailures = 0;
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        try {
          await apiUpload(`/jobs/${res.job.id}/attachments`, formData);
        } catch (err) {
          uploadFailures++;
        }
      }

      const emailMsg = res.email.sent ? 'Email sent to customer.' : 'Email logged (SMTP not configured).';
      const fileMsg = files.length
        ? (uploadFailures ? ` ${files.length - uploadFailures}/${files.length} file(s) uploaded, ${uploadFailures} failed.` : ` ${files.length} file(s) uploaded.`)
        : '';
      toast(`Job #${res.job.jobNumber} created. ${emailMsg}${fileMsg}`);

      e.target.reset();
      document.getElementById('jobCustomerId').value = '';
      document.getElementById('materialsList').innerHTML = '';
      addMaterialRow();
      document.getElementById('jobEngineerIds').selectedIndex = -1;
      if (pmSelect) pmSelect.value = '';
      loadJobs();
    } catch (err) {
      toast('Error: ' + err.message);
    }
  });
}

// ---------- Job list ----------
async function loadJobs() {
  const heading = document.getElementById('jobsHeading');
  heading.textContent = user.role === 'admin' ? 'All Jobs'
    : user.role === 'production_manager' ? 'Jobs I Created'
    : user.role === 'engineer' ? 'Jobs Assigned to Me'
    : 'My Jobs';

  const listEl = document.getElementById('jobsList');
  try {
    const jobs = await api('/jobs');
    if (jobs.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No jobs yet.</div>';
      return;
    }
    listEl.innerHTML = jobs.map((j) => {
      const engineerNames = (j.engineers || []).map((e) => e.name).join(', ') || 'Unassigned';
      return `
      <div class="job-card" data-id="${j.id}">
        <div class="job-card-top">
          <div>
            <span class="jt">${escapeHtml(j.title)}</span>
            <span class="jn">#${j.jobNumber}</span>
          </div>
          <span class="${badgeClass(j.status)}">${j.status}</span>
        </div>
        <div class="meta">
          Customer: ${escapeHtml(j.customerName)} &nbsp;•&nbsp; Engineers: ${escapeHtml(engineerNames)} &nbsp;•&nbsp; PM: ${escapeHtml(j.assignedPmName || 'Unassigned')}
          ${j.productionDetails?.deadline ? ' &nbsp;•&nbsp; Due ' + j.productionDetails.deadline : ''}
        </div>
      </div>
    `;
    }).join('');

    listEl.querySelectorAll('.job-card').forEach((card) => {
      card.addEventListener('click', () => openJobModal(card.dataset.id));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Failed to load jobs: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- Job detail modal ----------
const overlay = document.getElementById('modalOverlay');
document.getElementById('modalCloseBtn').addEventListener('click', () => overlay.classList.remove('open'));
overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('open'); });

async function openJobModal(id) {
  let job;
  try {
    job = await api('/jobs/' + id);
  } catch (err) {
    toast('Error: ' + err.message);
    return;
  }

  document.getElementById('modalTitle').textContent = `#${job.jobNumber} — ${job.title}`;
  const pd = job.productionDetails || {};

  // Mirrors the backend's permission model exactly (src/routes/jobs.js) so
  // we never show a control that would 403 — a PM only manages a job while
  // they're its *currently* assigned PM, not just because they created it.
  const isAssignedPM = user.role === 'production_manager' && job.assignedPmId === user.id;
  const isAssignedEngineer = user.role === 'engineer' && (job.engineers || []).some((e) => e.id === user.id);
  const canManageAssignments = user.role === 'admin' || isAssignedPM;
  const canManageJob = user.role === 'admin' || isAssignedPM || isAssignedEngineer;

  let actionsHtml = '';

  if (canManageAssignments) {
    const engineerChips = (job.engineers || []).map((e) => `
      <span class="role-chip" data-engineer-id="${e.id}">
        ${escapeHtml(e.name)}
        <button type="button" class="chip-remove-btn" data-engineer-id="${e.id}" title="Remove">×</button>
      </span>`).join('') || '<span class="empty-state">No engineers assigned yet.</span>';

    actionsHtml += `
      <div style="margin-top:16px;">
        <label>Engineers</label>
        <div class="role-chips" id="engineerChips">${engineerChips}</div>
        <div class="inline-form">
          <select id="addEngineerSelect"><option value="">Loading engineers…</option></select>
          <button class="btn-secondary" id="addEngineerBtn">Add Engineer</button>
        </div>
      </div>
      <div style="margin-top:16px;">
        <label>Production Manager</label>
        <div class="inline-form">
          <select id="pmSelect"><option value="">Loading production managers…</option></select>
          <button class="btn-secondary" id="savePmBtn">Save</button>
        </div>
      </div>`;
  }

  if (canManageJob) {
    const statuses = ['Created', 'Assigned', 'In Progress', 'QC Review', 'On Hold', 'Completed'];
    actionsHtml += `
      <div style="margin-top:16px;">
        <label>Update Status</label>
        <select id="statusSelect">
          ${statuses.map((s) => `<option value="${s}" ${s === job.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <label style="margin-top:8px;">Note (optional, included in email)</label>
        <textarea id="statusNote" placeholder="Progress notes…"></textarea>
        <button class="btn-secondary" id="statusBtn" style="margin-top:8px;">Update & Notify</button>
      </div>`;
  }

  const attachments = job.attachments || [];
  let filesHtml = `<h3 style="font-size:14px; margin-top:20px;">Files</h3>`;
  filesHtml += attachments.length
    ? `<ul class="file-list">${attachments.map((f) => `
        <li class="file-item" data-id="${f.id}" data-name="${escapeHtml(f.name)}">
          <span>📎 ${escapeHtml(f.name)} <span class="ts">(${escapeHtml(f.uploadedBy)})</span></span>
          <button class="btn-secondary download-file-btn">Download</button>
        </li>`).join('')}</ul>`
    : `<div class="empty-state" style="padding:10px 0;">No files uploaded yet.</div>`;

  if (canManageJob) {
    filesHtml += `
      <div class="inline-form" style="margin-top:10px;">
        <input type="file" id="attachmentFile" />
        <button class="btn-secondary" id="uploadFileBtn">Upload</button>
      </div>`;
  }

  document.getElementById('modalBody').innerHTML = `
    <span class="${badgeClass(job.status)}">${job.status}</span>
    <div style="margin-top:14px;">
      <div class="detail-row"><span>Customer</span><span>${escapeHtml(job.customerName)} (${escapeHtml(job.customerEmail)})</span></div>
      <div class="detail-row"><span>Engineers</span><span>${(job.engineers || []).length ? job.engineers.map((e) => escapeHtml(e.name)).join(', ') : 'Unassigned'}</span></div>
      <div class="detail-row"><span>Production Manager</span><span>${escapeHtml(job.assignedPmName || 'Unassigned')}</span></div>
      <div class="detail-row"><span>Materials</span><span>${
        (pd.materials || []).length
          ? (pd.materials || []).map((m) => `${escapeHtml(m.material) || '—'}${m.quantity ? ' (' + escapeHtml(m.quantity) + ')' : ''}`).join('<br/>')
          : '—'
      }</span></div>
      <div class="detail-row"><span>Priority</span><span>${escapeHtml(pd.priority) || '—'}</span></div>
      <div class="detail-row"><span>Deadline</span><span>${escapeHtml(pd.deadline) || '—'}</span></div>
    </div>
    ${job.description ? `<p style="font-size:13px; margin-top:12px;"><b>Description:</b> ${escapeHtml(job.description)}</p>` : ''}
    ${pd.specifications ? `<p style="font-size:13px;"><b>Specifications:</b> ${escapeHtml(pd.specifications)}</p>` : ''}

    ${actionsHtml}
    ${filesHtml}

    <h3 style="font-size:14px; margin-top:20px;">Status History</h3>
    <ul class="timeline">
      ${job.statusHistory.slice().reverse().map((h) => `
        <li>
          <b>${h.status}</b> — ${escapeHtml(h.note || '')}
          <div class="ts">${new Date(h.timestamp).toLocaleString()} · by ${escapeHtml(h.updatedBy)}</div>
        </li>`).join('')}
    </ul>
  `;

  overlay.classList.add('open');

  document.querySelectorAll('.download-file-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('.file-item');
      try {
        await apiDownload(`/jobs/${job.id}/attachments/${li.dataset.id}/download`, li.dataset.name);
      } catch (err) {
        toast('Download failed: ' + err.message);
      }
    });
  });

  const uploadBtn = document.getElementById('uploadFileBtn');
  if (uploadBtn) {
    uploadBtn.addEventListener('click', async () => {
      const fileInput = document.getElementById('attachmentFile');
      const file = fileInput.files[0];
      if (!file) { toast('Choose a file first'); return; }
      const formData = new FormData();
      formData.append('file', file);
      try {
        await apiUpload(`/jobs/${job.id}/attachments`, formData);
        toast('File uploaded.');
        openJobModal(job.id); // refresh modal with the new file listed
      } catch (err) {
        toast('Upload failed: ' + err.message);
      }
    });
  }

  if (canManageAssignments) {
    try {
      const engineers = await api('/users?role=engineer');
      const assignedIds = new Set((job.engineers || []).map((e) => e.id));
      const available = engineers.filter((e) => !assignedIds.has(e.id));
      const sel = document.getElementById('addEngineerSelect');
      sel.innerHTML = available.length
        ? '<option value="">Select engineer…</option>' + available.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.email)})</option>`).join('')
        : '<option value="">All engineers already assigned</option>';
    } catch (err) { /* ignore */ }

    document.getElementById('addEngineerBtn').addEventListener('click', async () => {
      const engineerId = document.getElementById('addEngineerSelect').value;
      if (!engineerId) { toast('Select an engineer first'); return; }
      try {
        const res = await api(`/jobs/${job.id}/engineers`, { method: 'POST', body: { engineerId } });
        toast(`Engineer added. ${res.email.sent ? 'Emails sent.' : 'Emails logged (SMTP not configured).'}`);
        openJobModal(job.id);
        loadJobs();
      } catch (err) {
        toast('Error: ' + err.message);
      }
    });

    document.querySelectorAll('.chip-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this engineer from the job?')) return;
        try {
          await api(`/jobs/${job.id}/engineers/${btn.dataset.engineerId}`, { method: 'DELETE' });
          toast('Engineer removed.');
          openJobModal(job.id);
          loadJobs();
        } catch (err) {
          toast('Error: ' + err.message);
        }
      });
    });

    try {
      const pms = await api('/users?role=production_manager');
      document.getElementById('pmSelect').innerHTML = '<option value="">Unassigned</option>' +
        pms.map((p) => `<option value="${p.id}" ${job.assignedPmId === p.id ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.email)})</option>`).join('');
    } catch (err) { /* ignore */ }

    document.getElementById('savePmBtn').addEventListener('click', async () => {
      const pmId = document.getElementById('pmSelect').value || null;
      try {
        await api(`/jobs/${job.id}/pm`, { method: 'PATCH', body: { pmId } });
        toast('Production manager updated.');
        openJobModal(job.id);
        loadJobs();
      } catch (err) {
        toast('Error: ' + err.message);
      }
    });
  }

  if (canManageJob) {
    document.getElementById('statusBtn').addEventListener('click', async () => {
      const status = document.getElementById('statusSelect').value;
      const note = document.getElementById('statusNote').value.trim();
      try {
        const res = await api(`/jobs/${job.id}/status`, { method: 'PATCH', body: { status, note } });
        toast(`Status updated to ${status}. ${res.email.sent ? 'Emails sent.' : 'Emails logged (SMTP not configured).'}`);
        overlay.classList.remove('open');
        loadJobs();
      } catch (err) {
        toast('Error: ' + err.message);
      }
    });
  }
}

initRolesPanel();
initCreateUserPanel();
initUsersPanel();
initCreateJobPanel();
loadJobs();
