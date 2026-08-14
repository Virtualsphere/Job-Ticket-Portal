const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const { sendJobEmail } = require('../mailer');
const { upload, UPLOAD_DIR } = require('../upload');

const router = express.Router();

const STATUS_FLOW = ['Created', 'Assigned', 'In Progress', 'QC Review', 'Completed', 'On Hold'];

const JOB_SELECT = `
  SELECT j.*,
    cu.name AS customerName, cu.email AS customerEmail,
    pm.name AS assignedPmName, pm.email AS assignedPmEmail,
    cb.name AS createdByName
  FROM jobs j
  JOIN users cu ON cu.id = j.customer_id
  LEFT JOIN users pm ON pm.id = j.assigned_pm_id
  JOIN users cb ON cb.id = j.created_by
`;

function shapeJob(row) {
  return {
    id: row.id,
    jobNumber: row.job_number,
    title: row.title,
    description: row.description || '',
    productionDetails: {
      material: row.material || '',
      quantity: row.quantity || '',
      priority: row.priority || 'Normal',
      deadline: row.deadline || '',
      specifications: row.specifications || '',
    },
    customerId: row.customer_id,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    engineers: [],
    assignedPmId: row.assigned_pm_id,
    assignedPmName: row.assignedPmName,
    assignedPmEmail: row.assignedPmEmail,
    createdById: row.created_by,
    createdByName: row.createdByName,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Side-loads the engineers assigned to a single job — mirrors the
// materials/attachments/history side-loading below, since engineers are now
// many-to-many and can't be flattened into the single JOB_SELECT row.
async function attachEngineers(job) {
  job.engineers = await query(
    `SELECT u.id, u.name, u.email FROM job_engineers je JOIN users u ON u.id = je.engineer_id
     WHERE je.job_id = ? ORDER BY u.name ASC`,
    [job.id]
  );
  return job;
}

// Batched version for job lists — one query instead of one-per-job.
async function attachEngineersBatch(jobs) {
  if (!jobs.length) return jobs;
  const rows = await query(
    `SELECT je.job_id, u.id, u.name, u.email FROM job_engineers je JOIN users u ON u.id = je.engineer_id
     WHERE je.job_id IN (?) ORDER BY u.name ASC`,
    [jobs.map((j) => j.id)]
  );
  const byJob = new Map();
  for (const r of rows) {
    if (!byJob.has(r.job_id)) byJob.set(r.job_id, []);
    byJob.get(r.job_id).push({ id: r.id, name: r.name, email: r.email });
  }
  jobs.forEach((job) => { job.engineers = byJob.get(job.id) || []; });
  return jobs;
}

async function loadJob(id) {
  const rows = await query(JOB_SELECT + ' WHERE j.id = ?', [id]);
  if (!rows.length) return null;
  return attachEngineers(shapeJob(rows[0]));
}

async function attachHistoryAndFiles(job) {
  job.statusHistory = await query(
    `SELECT h.status, h.note, h.created_at AS timestamp, u.name AS updatedBy
     FROM job_status_history h JOIN users u ON u.id = h.updated_by
     WHERE h.job_id = ? ORDER BY h.created_at ASC, h.id ASC`,
    [job.id]
  );
  job.attachments = await query(
    `SELECT a.id, a.original_filename AS name, a.size_bytes AS size,
            a.created_at AS uploadedAt, u.name AS uploadedBy
     FROM job_attachments a JOIN users u ON u.id = a.uploaded_by
     WHERE a.job_id = ? ORDER BY a.created_at DESC`,
    [job.id]
  );

  const materialRows = await query(
    'SELECT material, quantity FROM job_materials WHERE job_id = ? ORDER BY sort_order ASC, id ASC',
    [job.id]
  );
  // Jobs created before the job_materials table existed still carry a single
  // material/quantity on the jobs row itself — fall back to that as one line item.
  job.productionDetails.materials = materialRows.length
    ? materialRows.map((r) => ({ material: r.material || '', quantity: r.quantity || '' }))
    : (job.productionDetails.material || job.productionDetails.quantity)
      ? [{ material: job.productionDetails.material, quantity: job.productionDetails.quantity }]
      : [];

  return job;
}

function isAssignedPM(user, job) {
  return user.role === 'production_manager' && job.assignedPmId === user.id;
}

function isAssignedEngineer(user, job) {
  return user.role === 'engineer' && (job.engineers || []).some((e) => e.id === user.id);
}

// Who can add/remove engineers or change/remove the assigned production
// manager — Admin, or the job's *currently* assigned PM (not just whoever
// originally created it, since PM assignment can be handed off later).
function canManageAssignments(user, job) {
  return user.role === 'admin' || isAssignedPM(user, job);
}

// Admin sees/manages everything. Everyone else (customer, engineer, and
// production manager) is scoped to only the jobs they're personally tied to:
// their own job list, not the whole company's.
function canView(user, job) {
  return (
    user.role === 'admin' ||
    isAssignedPM(user, job) ||
    isAssignedEngineer(user, job) ||
    (user.role === 'customer' && job.customerId === user.id)
  );
}

function canManage(user, job) {
  // Who can change status or attach files.
  return user.role === 'admin' || isAssignedPM(user, job) || isAssignedEngineer(user, job);
}

// Create a job — Admin or Production Manager
router.post('/', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const { title, description, customerId, productionDetails, pmId, engineerIds } = req.body;
  if (!title || !customerId) return res.status(400).json({ error: 'title and customerId are required' });

  const customers = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND r.name = 'customer'`,
    [customerId]
  );
  if (!customers.length) return res.status(400).json({ error: 'Selected customer not found' });

  // A production manager creating a job is always its assigned PM. Only
  // admin can hand a job to a specific PM (or leave it unassigned) at
  // creation time.
  let assignedPmId = null;
  if (req.user.role === 'production_manager') {
    assignedPmId = req.user.id;
  } else if (req.user.role === 'admin' && pmId) {
    const pms = await query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND r.name = 'production_manager'`,
      [pmId]
    );
    if (!pms.length) return res.status(400).json({ error: 'Selected production manager not found' });
    assignedPmId = pmId;
  }

  const requestedEngineerIds = Array.isArray(engineerIds)
    ? [...new Set(engineerIds.map(Number).filter(Boolean))]
    : [];
  let engineers = [];
  if (requestedEngineerIds.length) {
    engineers = await query(
      `SELECT u.id, u.name, u.email FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'engineer' AND u.id IN (?)`,
      [requestedEngineerIds]
    );
    if (engineers.length !== requestedEngineerIds.length) {
      return res.status(400).json({ error: 'One or more selected engineers were not found' });
    }
  }

  const pd = productionDetails || {};
  const materials = (Array.isArray(pd.materials) ? pd.materials : [])
    .map((m) => ({ material: (m.material || '').trim(), quantity: (m.quantity || '').trim() }))
    .filter((m) => m.material || m.quantity);

  const result = await query(
    `INSERT INTO jobs (title, description, priority, deadline, specifications, customer_id, created_by, assigned_pm_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Created')`,
    [
      title,
      description || '',
      pd.priority || 'Normal',
      pd.deadline || null,
      pd.specifications || '',
      customerId,
      req.user.id,
      assignedPmId,
    ]
  );
  const jobId = result.insertId;
  const jobNumber = 1000 + jobId;
  await query('UPDATE jobs SET job_number = ? WHERE id = ?', [jobNumber, jobId]);
  for (let i = 0; i < materials.length; i++) {
    await query(
      'INSERT INTO job_materials (job_id, material, quantity, sort_order) VALUES (?, ?, ?, ?)',
      [jobId, materials[i].material, materials[i].quantity, i]
    );
  }
  for (const eng of engineers) {
    await query('INSERT IGNORE INTO job_engineers (job_id, engineer_id, assigned_by) VALUES (?, ?, ?)', [jobId, eng.id, req.user.id]);
  }
  if (engineers.length) {
    await query('UPDATE jobs SET status = ? WHERE id = ?', ['Assigned', jobId]);
  }
  await query(
    'INSERT INTO job_status_history (job_id, status, note, updated_by) VALUES (?, ?, ?, ?)',
    [
      jobId,
      engineers.length ? 'Assigned' : 'Created',
      engineers.length ? `Job ticket created and assigned to ${engineers.map((e) => e.name).join(', ')}` : 'Job ticket created',
      req.user.id,
    ]
  );

  const job = await attachHistoryAndFiles(await loadJob(jobId));
  // Only the job_created email fires here (it already shows the initial
  // engineer/PM state) — firing job_assigned too would double-email when
  // engineers are pre-selected on the create form.
  const pmRecipient = job.assignedPmId && job.assignedPmId !== req.user.id ? job.assignedPmEmail : null;
  const emailResult = await sendJobEmail('job_created', job, [job.customerEmail, pmRecipient].filter(Boolean));
  res.status(201).json({ job, email: emailResult });
});

// List jobs — filtered by role. Admin sees everything.
router.get('/', verifyToken, async (req, res) => {
  let sql;
  const params = [];
  if (req.user.role === 'engineer') {
    sql = `
      SELECT j.*,
        cu.name AS customerName, cu.email AS customerEmail,
        pm.name AS assignedPmName, pm.email AS assignedPmEmail,
        cb.name AS createdByName
      FROM jobs j
      JOIN job_engineers je ON je.job_id = j.id
      JOIN users cu ON cu.id = j.customer_id
      LEFT JOIN users pm ON pm.id = j.assigned_pm_id
      JOIN users cb ON cb.id = j.created_by
      WHERE je.engineer_id = ?`;
    params.push(req.user.id);
  } else {
    sql = JOB_SELECT;
    if (req.user.role === 'customer') {
      sql += ' WHERE j.customer_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'production_manager') {
      sql += ' WHERE j.assigned_pm_id = ?';
      params.push(req.user.id);
    }
    // admin: no filter — sees every job
  }
  sql += ' ORDER BY j.created_at DESC';
  const rows = await query(sql, params);
  const jobs = rows.map(shapeJob);
  await attachEngineersBatch(jobs);
  res.json(jobs);
});

// Get single job — must be Admin, the assigned PM, an assigned engineer, or the owning customer
router.get('/:id', verifyToken, async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canView(req.user, job)) return res.status(403).json({ error: 'Not authorized to view this job' });
  res.json(await attachHistoryAndFiles(job));
});

// Add an engineer to a job — Admin or the job's assigned Production Manager
router.post('/:id/engineers', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const { engineerId } = req.body;
  if (!engineerId) return res.status(400).json({ error: 'engineerId is required' });

  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canManageAssignments(req.user, job)) {
    return res.status(403).json({ error: 'Not authorized to manage this job' });
  }

  const matches = await query(
    `SELECT u.id, u.name, u.email FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND r.name = 'engineer'`,
    [engineerId]
  );
  if (!matches.length) return res.status(400).json({ error: 'Selected engineer not found' });
  const engineer = matches[0];

  if (job.engineers.some((e) => e.id === engineer.id)) {
    return res.status(409).json({ error: 'Engineer is already assigned to this job' });
  }

  await query('INSERT INTO job_engineers (job_id, engineer_id, assigned_by) VALUES (?, ?, ?)', [job.id, engineer.id, req.user.id]);
  const nextStatus = job.status === 'Created' ? 'Assigned' : job.status;
  if (nextStatus !== job.status) {
    await query('UPDATE jobs SET status = ? WHERE id = ?', [nextStatus, job.id]);
  }
  await query(
    'INSERT INTO job_status_history (job_id, status, note, updated_by) VALUES (?, ?, ?, ?)',
    [job.id, nextStatus, `Engineer added: ${engineer.name}`, req.user.id]
  );

  const updatedJob = await attachHistoryAndFiles(await loadJob(job.id));
  const emailResult = await sendJobEmail('job_assigned', updatedJob, [engineer.email, updatedJob.customerEmail]);
  res.json({ job: updatedJob, email: emailResult });
});

// Remove an engineer from a job — Admin or the job's assigned Production Manager
router.delete('/:id/engineers/:engineerId', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canManageAssignments(req.user, job)) {
    return res.status(403).json({ error: 'Not authorized to manage this job' });
  }

  const engineerId = Number(req.params.engineerId);
  const target = job.engineers.find((e) => e.id === engineerId);
  if (!target) return res.status(404).json({ error: 'Engineer is not assigned to this job' });

  await query('DELETE FROM job_engineers WHERE job_id = ? AND engineer_id = ?', [job.id, engineerId]);
  // Status is left unchanged even if this was the last engineer — status
  // transitions stay a deliberate, manual action via PATCH /:id/status.
  await query(
    'INSERT INTO job_status_history (job_id, status, note, updated_by) VALUES (?, ?, ?, ?)',
    [job.id, job.status, `Engineer removed: ${target.name}`, req.user.id]
  );

  const updatedJob = await attachHistoryAndFiles(await loadJob(job.id));
  res.json({ job: updatedJob });
});

// Assign / change / remove the Production Manager — Admin or the job's current assigned PM
router.patch('/:id/pm', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canManageAssignments(req.user, job)) {
    return res.status(403).json({ error: 'Not authorized to manage this job' });
  }

  const { pmId } = req.body;
  let newPm = null;
  if (pmId) {
    const pms = await query(
      `SELECT u.id, u.name, u.email FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND r.name = 'production_manager'`,
      [pmId]
    );
    if (!pms.length) return res.status(400).json({ error: 'Selected production manager not found' });
    newPm = pms[0];
  }

  await query('UPDATE jobs SET assigned_pm_id = ? WHERE id = ?', [newPm ? newPm.id : null, job.id]);
  await query(
    'INSERT INTO job_status_history (job_id, status, note, updated_by) VALUES (?, ?, ?, ?)',
    [job.id, job.status, newPm ? `Production Manager set to ${newPm.name}` : 'Production Manager removed', req.user.id]
  );

  const updatedJob = await attachHistoryAndFiles(await loadJob(job.id));
  res.json({ job: updatedJob });
});

// Update status — Admin, the assigned Production Manager, or an assigned Engineer
router.patch('/:id/status', verifyToken, async (req, res) => {
  const { status, note } = req.body;
  if (!status || !STATUS_FLOW.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUS_FLOW.join(', ')}` });
  }

  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canManage(req.user, job)) return res.status(403).json({ error: 'Not authorized to update this job' });

  await query('UPDATE jobs SET status = ? WHERE id = ?', [status, job.id]);
  await query(
    'INSERT INTO job_status_history (job_id, status, note, updated_by) VALUES (?, ?, ?, ?)',
    [job.id, status, note || '', req.user.id]
  );

  const updatedJob = await attachHistoryAndFiles(await loadJob(job.id));
  const recipients = [updatedJob.customerEmail, ...updatedJob.engineers.map((e) => e.email)].filter(Boolean);
  const emailType = status === 'Completed' ? 'job_completed' : 'status_update';
  const emailResult = await sendJobEmail(emailType, updatedJob, recipients, note);
  res.json({ job: updatedJob, email: emailResult });
});

// Upload a file attachment — Admin, the assigned Production Manager, or an assigned Engineer
router.post('/:id/attachments', verifyToken, upload.single('file'), async (req, res) => {
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };

  const job = await loadJob(req.params.id);
  if (!job) { cleanup(); return res.status(404).json({ error: 'Job not found' }); }
  if (!canManage(req.user, job)) { cleanup(); return res.status(403).json({ error: 'Not authorized to upload files to this job' }); }
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  const result = await query(
    `INSERT INTO job_attachments (job_id, stored_filename, original_filename, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [job.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user.id]
  );
  res.status(201).json({ id: result.insertId, name: req.file.originalname, size: req.file.size });
});

// Download a file attachment — anyone who can view the job
router.get('/:id/attachments/:attachmentId/download', verifyToken, async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canView(req.user, job)) return res.status(403).json({ error: 'Not authorized to view this job' });

  const files = await query('SELECT * FROM job_attachments WHERE id = ? AND job_id = ?', [req.params.attachmentId, job.id]);
  if (!files.length) return res.status(404).json({ error: 'File not found' });

  const file = files[0];
  const filePath = path.join(UPLOAD_DIR, file.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on server' });
  res.download(filePath, file.original_filename);
});

module.exports = router;
