# Job Ticket Portal

A full-stack app for creating and tracking production job tickets, with
**Admin**, **Production Manager**, **Engineer**, and **Customer** roles,
backed by **MySQL**, with real email notifications via **Nodemailer + Gmail**
at every stage (created, assigned, progress update, completed).

## What changed from the demo version

- **No public sign-up.** There is no self-registration anymore. The very
  first **Admin** account is created once from the command line
  (`npm run seed:admin`), and every other account (Production Manager,
  Engineer, Customer) is created by an Admin from the in-app Admin panel.
- **Roles live in the database**, not hardcoded strings sent by the browser.
  Admin can add new roles from the Roles panel; the "Role" dropdown when
  creating a user is always populated from that table, so there's no way to
  create a typo'd or conflicting role.
- **MySQL storage** instead of the JSON file (`data/db.json` is gone).
- **File attachments.** Jobs can now have files attached (drawings, specs,
  photos, etc.), stored on disk and access-controlled the same way job
  details are.
- **Customer search field.** When creating a job, instead of a long
  dropdown, start typing a customer's name or email — matches with that
  text show up, click one to select it (the box then shows the selected
  email). The backend receives just the customer's id.
- **Admin can create jobs too**, not only the Production Manager.
- **Visibility**: Admin sees everything. Production Manager, Engineer, and
  Customer each only see the jobs they're personally tied to (created,
  assigned, or owned, respectively).

## 1. Install

```bash
npm install
```

## 2. Set up MySQL

Make sure a MySQL server is running and reachable, then:

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=job_ticket_portal
```

Create the database and tables (safe to re-run):

```bash
npm run migrate
```

This creates the `roles`, `users`, `jobs`, `job_status_history`, and
`job_attachments` tables, and seeds the four default roles: `admin`,
`production_manager`, `engineer`, `customer`.

## 3. Create the first Admin account

Still in `.env`, set:

```
ADMIN_NAME=Site Admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=a_strong_password
```

Then run:

```bash
npm run seed:admin
```

This is a one-time CLI step — there is intentionally no web form for it,
since letting anyone reach an "admin" role from the browser would defeat
the point of admin-controlled registration. Re-running it is safe; it just
skips if that email already has an account.

## 4. Configure Gmail sending (optional but recommended)

1. Turn on 2-Step Verification on the Gmail account you'll send from:
   https://myaccount.google.com/security
2. Create an **App Password**: https://myaccount.google.com/apppasswords
   (choose "Mail" as the app). Gmail gives you a 16-character password —
   use that, not your normal Gmail password.
3. In `.env`:

```
GMAIL_USER=youraccount@gmail.com
GMAIL_APP_PASSWORD=the16charapppassword
```

If you skip this, the app still works fully — emails are printed to the
server console instead of sent (`[mailer:LOG-ONLY]` lines).

## 5. Run

```bash
npm start
```

Then open **http://localhost:3000** and log in with the admin account you
seeded.

## 6. Try it out

1. **Log in as Admin.**
   - Add any extra roles you need from the **Roles** panel (e.g.
     `quality_inspector`) — optional, the four defaults already cover the
     core workflow.
   - Use **Create User Account** to register a Production Manager, an
     Engineer, and a Customer. Use real email addresses for the engineer
     and customer if you want to actually receive notification emails.
2. **Log in as the Production Manager (or stay as Admin)** → **Create a New
   Job**. In the Customer field, type part of the customer's name or email
   — pick the match from the dropdown — then fill in the production
   details and submit. The customer gets a "Job Created" email.
3. Open the job → **Assign Engineer** → pick the engineer you registered.
   Both the engineer and customer get a "Job Assigned" email.
4. Open the job again → attach a file (drawing, spec sheet, etc.) using the
   upload box — it appears in the Files list for anyone allowed to view
   that job.
5. Update status to "In Progress" / "QC Review" / "Completed" with an
   optional note. Customer and engineer both get an email each time;
   "Completed" sends a distinct completion email.
6. **Log in as the customer** to see only their own jobs, read-only, with
   the full status timeline and any attached files.

## Notes on hardening before real production use

- **Secrets**: never commit your real `.env` file — keep DB credentials,
  `JWT_SECRET`, and the Gmail app password out of version control.
- **Gmail sending limits**: a personal Gmail account caps around 500
  emails/day. For real volume, use Google Workspace or a transactional
  email provider (SES, SendGrid, Postmark) — Nodemailer supports all of
  them with a small config change in `src/mailer.js`.
- **File storage**: attachments are stored on local disk
  (`UPLOAD_DIR`, default `./uploads`). For a multi-server deployment,
  swap this for S3 or similar — the upload/download logic lives entirely
  in `src/upload.js` and the attachment routes in `src/routes/jobs.js`.
- **Password resets**: there's currently no self-service "forgot password"
  flow — an Admin would need to create a fresh account or you'd add a
  reset-token endpoint.

## Project structure

```
job-portal/
  server.js                  Express app entry point
  db/
    schema.sql                MySQL schema + default role seed
  scripts/
    migrate.js                 Creates the DB + runs schema.sql
    seed-admin.js               One-time CLI: creates the first admin account
  src/
    db.js                       MySQL connection pool + query helper
    auth.js                     JWT sign/verify, role-check middleware
    upload.js                   Multer disk storage config for attachments
    mailer.js                   Nodemailer transporter + email templates
    routes/
      auth.js                    login / me  (no public register)
      roles.js                   admin: list / create roles
      users.js                   admin: create users; admin+PM: list/search users
      jobs.js                    create / list / assign / status / attachments
  public/                     Frontend (plain HTML/CSS/JS, no build step)
    index.html                  Login only
    dashboard.html               Role-based dashboard shell (admin panels,
                                  create-job form with customer search)
    js/, css/
  uploads/                    Job attachment files (auto-created, gitignored)
  .env.example                 Copy to .env and fill in DB + Gmail + admin seed
```
