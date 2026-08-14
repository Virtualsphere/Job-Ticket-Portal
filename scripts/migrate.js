require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const dbName = process.env.DB_NAME || 'job_ticket_portal';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`);
  await conn.query(`USE \`${dbName}\``);

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
  await conn.query(schema);
  await migrateEngineersAndPm(conn, dbName);

  console.log(`Database "${dbName}" is up to date (tables created, default roles seeded).`);
  await conn.end();
}

async function columnExists(conn, dbName, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  return rows[0].cnt > 0;
}

async function foreignKeyExists(conn, dbName, table, constraintName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [dbName, table, constraintName]
  );
  return rows[0].cnt > 0;
}

// Upgrades a database created before multi-engineer/PM support existed:
// moves the old single assigned_engineer_id into job_engineers, backfills
// assigned_pm_id for jobs a production manager already created (so they
// don't lose visibility into their own in-flight jobs), then drops the old
// column. Every step is guarded so re-running this is always a safe no-op
// once the database is caught up — schema.sql itself can't express this
// (MySQL 8 doesn't reliably support conditional ADD COLUMN / DROP FOREIGN
// KEY declaratively), so it's driven from here instead.
async function migrateEngineersAndPm(conn, dbName) {
  const hadOldEngineerCol = await columnExists(conn, dbName, 'jobs', 'assigned_engineer_id');
  const hadPmCol = await columnExists(conn, dbName, 'jobs', 'assigned_pm_id');

  if (!hadPmCol) {
    console.log('[migrate] Adding jobs.assigned_pm_id column...');
    await conn.query('ALTER TABLE jobs ADD COLUMN assigned_pm_id INT DEFAULT NULL AFTER customer_id');
  }
  if (!(await foreignKeyExists(conn, dbName, 'jobs', 'fk_jobs_pm'))) {
    console.log('[migrate] Adding fk_jobs_pm foreign key...');
    await conn.query('ALTER TABLE jobs ADD CONSTRAINT fk_jobs_pm FOREIGN KEY (assigned_pm_id) REFERENCES users(id)');
  }

  if (hadOldEngineerCol) {
    console.log('[migrate] Backfilling job_engineers from jobs.assigned_engineer_id...');
    await conn.query(`
      INSERT IGNORE INTO job_engineers (job_id, engineer_id, assigned_by)
      SELECT id, assigned_engineer_id, created_by FROM jobs WHERE assigned_engineer_id IS NOT NULL
    `);
  }

  if (!hadPmCol) {
    console.log('[migrate] Backfilling assigned_pm_id for jobs created by production managers...');
    await conn.query(`
      UPDATE jobs j
      JOIN users u ON u.id = j.created_by
      JOIN roles r ON r.id = u.role_id
      SET j.assigned_pm_id = j.created_by
      WHERE r.name = 'production_manager' AND j.assigned_pm_id IS NULL
    `);
  }

  if (hadOldEngineerCol) {
    if (await foreignKeyExists(conn, dbName, 'jobs', 'fk_jobs_engineer')) {
      console.log('[migrate] Dropping fk_jobs_engineer foreign key...');
      await conn.query('ALTER TABLE jobs DROP FOREIGN KEY fk_jobs_engineer');
    }
    console.log('[migrate] Dropping jobs.assigned_engineer_id column...');
    await conn.query('ALTER TABLE jobs DROP COLUMN assigned_engineer_id');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
