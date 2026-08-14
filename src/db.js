const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'job_ticket_portal',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});

// Thin helper: for SELECT this returns an array of row objects; for
// INSERT/UPDATE/DELETE it returns the ResultSetHeader (insertId, affectedRows, ...).
async function query(sql, params) {
  const [result] = await pool.query(sql, params);
  return result;
}

module.exports = { pool, query };
