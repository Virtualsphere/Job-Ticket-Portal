-- Job Ticket Portal — MySQL schema
-- Run via `npm run migrate` (see scripts/migrate.js). Safe to re-run.

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT NOT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id),
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_number INT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  material VARCHAR(150),
  quantity VARCHAR(100),
  priority VARCHAR(20) DEFAULT 'Normal',
  deadline DATE NULL,
  specifications TEXT,
  customer_id INT NOT NULL,
  assigned_pm_id INT DEFAULT NULL,
  created_by INT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'Created',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_jobs_customer FOREIGN KEY (customer_id) REFERENCES users(id),
  CONSTRAINT fk_jobs_pm FOREIGN KEY (assigned_pm_id) REFERENCES users(id),
  CONSTRAINT fk_jobs_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Many-to-many: a job can have multiple engineers working on it.
CREATE TABLE IF NOT EXISTS job_engineers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_id INT NOT NULL,
  engineer_id INT NOT NULL,
  assigned_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_engineer (job_id, engineer_id),
  CONSTRAINT fk_je_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_je_engineer FOREIGN KEY (engineer_id) REFERENCES users(id),
  CONSTRAINT fk_je_assigned_by FOREIGN KEY (assigned_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS job_materials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_id INT NOT NULL,
  material VARCHAR(150),
  quantity VARCHAR(100),
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_jobmat_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS job_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_id INT NOT NULL,
  status VARCHAR(30) NOT NULL,
  note TEXT,
  updated_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hist_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_hist_user FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS job_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_id INT NOT NULL,
  stored_filename VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(150),
  size_bytes INT,
  uploaded_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_att_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_att_user FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- Default roles. Admin can add more later from the Roles panel.
INSERT IGNORE INTO roles (name, description) VALUES
  ('admin', 'Full access — manages roles, users and all jobs'),
  ('production_manager', 'Creates job tickets and assigns engineers'),
  ('engineer', 'Works on jobs assigned to them'),
  ('customer', 'Views their own jobs, read-only');
