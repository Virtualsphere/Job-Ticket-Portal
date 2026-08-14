const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Job Ticket Portal';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

let transporter = null;
let mailEnabled = false;

if (GMAIL_USER && GMAIL_APP_PASSWORD && GMAIL_APP_PASSWORD !== 'xxxxxxxxxxxxxxxx') {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  mailEnabled = true;
  transporter.verify((err) => {
    if (err) {
      console.warn('[mailer] Gmail SMTP verification failed. Emails will be logged only. Reason:', err.message);
      mailEnabled = false;
    } else {
      console.log('[mailer] Gmail SMTP connected — emails will be sent for real.');
    }
  });
} else {
  console.warn('[mailer] GMAIL_USER / GMAIL_APP_PASSWORD not set in .env — running in LOG-ONLY mode. Emails will be printed to the console instead of sent.');
}

function statusBadgeColor(status) {
  const map = {
    Created: '#6b7280',
    Assigned: '#2563eb',
    'In Progress': '#d97706',
    'QC Review': '#7c3aed',
    'On Hold': '#dc2626',
    Completed: '#16a34a',
  };
  return map[status] || '#374151';
}

function baseTemplate({ heading, intro, job, footerNote }) {
  const color = statusBadgeColor(job.status);
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color:#1f2937;">
    <div style="background:#111827; padding:20px 24px; border-radius:8px 8px 0 0;">
      <h2 style="color:#fff; margin:0; font-size:18px;">${heading}</h2>
    </div>
    <div style="border:1px solid #e5e7eb; border-top:none; padding:24px; border-radius:0 0 8px 8px;">
      <p style="font-size:14px; line-height:1.5;">${intro}</p>
      <table style="width:100%; border-collapse:collapse; font-size:14px; margin-top:12px;">
        <tr><td style="padding:6px 0; color:#6b7280;">Job Number</td><td style="padding:6px 0; font-weight:bold;">#${job.jobNumber}</td></tr>
        <tr><td style="padding:6px 0; color:#6b7280;">Title</td><td style="padding:6px 0;">${job.title}</td></tr>
        <tr><td style="padding:6px 0; color:#6b7280;">Status</td><td style="padding:6px 0;">
          <span style="background:${color}; color:#fff; padding:2px 10px; border-radius:12px; font-size:12px;">${job.status}</span>
        </td></tr>
        <tr><td style="padding:6px 0; color:#6b7280;">Customer</td><td style="padding:6px 0;">${job.customerName} (${job.customerEmail})</td></tr>
        <tr><td style="padding:6px 0; color:#6b7280;">Assigned Engineer</td><td style="padding:6px 0;">${job.assignedEngineerName || 'Not yet assigned'}</td></tr>
        <tr><td style="padding:6px 0; color:#6b7280;">Deadline</td><td style="padding:6px 0;">${job.productionDetails?.deadline || 'N/A'}</td></tr>
      </table>
      <p style="font-size:13px; color:#6b7280; margin-top:18px;">${footerNote || ''}</p>
      <a href="${APP_BASE_URL}" style="display:inline-block; margin-top:10px; background:#111827; color:#fff; text-decoration:none; padding:10px 16px; border-radius:6px; font-size:13px;">Open Job Ticket Portal</a>
    </div>
  </div>`;
}

const TEMPLATES = {
  job_created: (job) => ({
    subject: `New Job Ticket Created — #${job.jobNumber} ${job.title}`,
    html: baseTemplate({
      heading: 'New Job Ticket Created',
      intro: `A new job ticket has been created and logged in the system.`,
      job,
      footerNote: 'You will receive further updates as this job progresses.',
    }),
  }),
  job_assigned: (job) => ({
    subject: `Job Ticket Assigned — #${job.jobNumber} ${job.title}`,
    html: baseTemplate({
      heading: 'Job Ticket Assigned to an Engineer',
      intro: `This job ticket has been assigned to <b>${job.assignedEngineerName}</b>.`,
      job,
      footerNote: 'Work is expected to begin shortly.',
    }),
  }),
  status_update: (job, note) => ({
    subject: `Job Status Update — #${job.jobNumber}: ${job.status}`,
    html: baseTemplate({
      heading: 'Job Status Updated',
      intro: `The status of this job has been updated to <b>${job.status}</b>.${note ? `<br/><br/><i>Note: ${note}</i>` : ''}`,
      job,
      footerNote: 'Thanks for your patience — we will keep you posted.',
    }),
  }),
  job_completed: (job) => ({
    subject: `Job Completed — #${job.jobNumber} ${job.title}`,
    html: baseTemplate({
      heading: 'Job Ticket Completed ✅',
      intro: `Good news — this job ticket has been marked <b>Completed</b>.`,
      job,
      footerNote: 'Please reach out if you have any questions about the finished work.',
    }),
  }),
};

async function dispatch(to, subject, html) {
  if (!to) return { sent: false, reason: 'no recipients' };

  if (!mailEnabled || !transporter) {
    console.log(`\n[mailer:LOG-ONLY] To: ${to}\nSubject: ${subject}\n(Set GMAIL_USER + GMAIL_APP_PASSWORD in .env to actually send this)\n`);
    return { sent: false, logged: true };
  }

  try {
    await transporter.sendMail({
      from: `"${MAIL_FROM_NAME}" <${GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Failed to send email:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send a job-lifecycle email to one or more recipients.
 * type: 'job_created' | 'job_assigned' | 'status_update' | 'job_completed'
 */
async function sendJobEmail(type, job, recipients, note) {
  const build = TEMPLATES[type];
  if (!build) throw new Error(`Unknown email template type: ${type}`);
  const { subject, html } = build(job, note);
  const to = (Array.isArray(recipients) ? recipients : [recipients]).filter(Boolean).join(', ');
  return dispatch(to, subject, html);
}

/**
 * Send a welcome email with login credentials to a newly created user.
 */
async function sendAccountCreatedEmail(user, plainPassword, roleName) {
  const subject = `Your ${MAIL_FROM_NAME} account has been created`;
  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color:#1f2937;">
    <div style="background:#111827; padding:20px 24px; border-radius:8px 8px 0 0;">
      <h2 style="color:#fff; margin:0; font-size:18px;">Welcome to ${MAIL_FROM_NAME}</h2>
    </div>
    <div style="border:1px solid #e5e7eb; border-top:none; padding:24px; border-radius:0 0 8px 8px;">
      <p style="font-size:14px; line-height:1.5;">Hi ${user.name},</p>
      <p style="font-size:14px; line-height:1.5;">An administrator has created an account for you on the ${MAIL_FROM_NAME}. You can log in using the credentials below:</p>
      <table style="width:100%; border-collapse:collapse; font-size:14px; margin-top:12px;">
        <tr><td style="padding:6px 0; color:#6b7280;">Email</td><td style="padding:6px 0; font-weight:bold;">${user.email}</td></tr>
        <tr><td style="padding:6px 0; color:#6b7280;">Temporary Password</td><td style="padding:6px 0; font-weight:bold;">${plainPassword}</td></tr>
        <tr><td style="padding:6px 0; color:#6b7280;">Role</td><td style="padding:6px 0;">${roleName}</td></tr>
      </table>
      <p style="font-size:13px; color:#6b7280; margin-top:18px;">For security, please log in and change your password as soon as possible.</p>
      <a href="${APP_BASE_URL}" style="display:inline-block; margin-top:10px; background:#111827; color:#fff; text-decoration:none; padding:10px 16px; border-radius:6px; font-size:13px;">Log In</a>
    </div>
  </div>`;
  return dispatch(user.email, subject, html);
}

module.exports = { sendJobEmail, sendAccountCreatedEmail, mailEnabled: () => mailEnabled };
