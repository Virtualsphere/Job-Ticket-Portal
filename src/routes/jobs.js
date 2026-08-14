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
    en.name AS assignedEngineerName, en.email AS assignedEngineerEmail,
    cb.name AS createdByName
  FROM jobs j
  JOIN users cu ON cu.id = j.customer_id
  LEFT JOIN users en ON en.id = j.assigned_engineer_id
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
    assignedEngineerId: row.assigned_engineer_id,
    assignedEngineerName: row.assignedEngineerName,
    assignedEngineerEmail: row.assignedEngineerEmail,
    createdById: row.created_by,
    createdByName: row.createdByName,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadJob(id) {
  const rows = await query(JOB_SELECT + ' WHERE j.id = ?', [id]);
  if (!rows.length) return null;
  return shapeJob(rows[0]);
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

function isOwningPM(user, job) {
  return user.role === 'production_manager' && job.createdById === user.id;
}

// Admin sees/manages everything. Everyone else (customer, engineer, and
// production manager) is scoped to only the jobs they're personally tied to:
// their own job list, not the whole company's.
function canView(user, job) {
  return (
    user.role === 'admin' ||
    isOwningPM(user, job) ||
    (user.role === 'engineer' && job.assignedEngineerId === user.id) ||
    (user.role === 'customer' && job.customerId === user.id)
  );
}

function canManage(user, job) {
  // Who can assign an engineer, change status, or attach files.
  return (
    user.role === 'admin' ||
    isOwningPM(user, job) ||
    (user.role === 'engineer' && job.assignedEngineerId === user.id)
  );
}

// Create a job — Admin or Production Manager
router.post('/', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const { title, description, customerId, productionDetails } = req.body;
  if (!title || !customerId) return res.status(400).json({ error: 'title and customerId are required' });

  const customers = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND r.name = 'customer'`,
    [customerId]
  );
  if (!customers.length) return res.status(400).json({ error: 'Selected customer not found' });

  const pd = productionDetails || {};
  const materials = (Array.isArray(pd.materials) ? pd.materials : [])
    .map((m) => ({ material: (m.material || '').trim(), quantity: (m.quantity || '').trim() }))
    .filter((m) => m.material || m.quantity);

  const result = await query(
    `INSERT INTO jobs (title, description, priority, deadline, specifications, customer_id, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Created')`,
    [
      title,
      description || '',
      pd.priority || 'Normal',
      pd.deadline || null,
      pd.specifications || '',
      customerId,
      req.user.id,
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
  await query(
    'INSERT INTO job_status_history (job_id, status, note, updated_by) VALUES (?, ?, ?, ?)',
    [jobId, 'Created', 'Job ticket created', req.user.id]
  );

  const job = await attachHistoryAndFiles(await loadJob(jobId));
  const emailResult = await sendJobEmail('job_created', job, [job.customerEmail]);
  res.status(201).json({ job, email: emailResult });
});

// List jobs — filtered by role. Admin and Production Manager see everything.
router.get('/', verifyToken, async (req, res) => {
  let sql = JOB_SELECT;
  const params = [];
  if (req.user.role === 'engineer') {
    sql += ' WHERE j.assigned_engineer_id = ?';
    params.push(req.user.id);
  } else if (req.user.role === 'customer') {
    sql += ' WHERE j.customer_id = ?';
    params.push(req.user.id);
  } else if (req.user.role === 'production_manager') {
    sql += ' WHERE j.created_by = ?';
    params.push(req.user.id);
  }
  // admin: no filter — sees every job
  sql += ' ORDER BY j.created_at DESC';
  const rows = await query(sql, params);
  res.json(rows.map(shapeJob));
});

// Get single job — must be Admin, PM, the assigned engineer, or the owning customer
router.get('/:id', verifyToken, async (req, res) => {
  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!canView(req.user, job)) return res.status(403).json({ error: 'Not authorized to view this job' });
  res.json(await attachHistoryAndFiles(job));
});

// Assign an engineer — Admin or Production Manager
router.patch('/:id/assign', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const { engineerId } = req.body;
  if (!engineerId) return res.status(400).json({ error: 'engineerId is required' });

  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.user.role !== 'admin' && !isOwningPM(req.user, job)) {
    return res.status(403).json({ error: 'Not authorized to manage this job' });
  }

  const engineers = await query(
    `SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND r.name = 'engineer'`,
    [engineerId]
  );
  if (!engineers.length) return res.status(400).json({ error: 'Selected engineer not found' });

  await query('UPDATE jobs SET assigned_engineer_id = ?, status = ? WHERE id = ?', [engineerId, 'Assigned', job.id]);
  await query(
    'INSERT INTO job_status_history (job_id, status, note, updated_by) VALUES (?, ?, ?, ?)',
    [job.id, 'Assigned', `Assigned to ${engineers[0].name}`, req.user.id]
  );

  const updatedJob = await attachHistoryAndFiles(await loadJob(job.id));
  const emailResult = await sendJobEmail('job_assigned', updatedJob, [updatedJob.assignedEngineerEmail, updatedJob.customerEmail]);
  res.json({ job: updatedJob, email: emailResult });
});

// Update status — Admin, Production Manager, or the assigned Engineer
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
  const recipients = [updatedJob.customerEmail, updatedJob.assignedEngineerEmail].filter(Boolean);
  const emailType = status === 'Completed' ? 'job_completed' : 'status_update';
  const emailResult = await sendJobEmail(emailType, updatedJob, recipients, note);
  res.json({ job: updatedJob, email: emailResult });
});

// Upload a file attachment — Admin, Production Manager, or the assigned Engineer
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
