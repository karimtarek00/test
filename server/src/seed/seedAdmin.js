import { get, run } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';

const username = process.env.SEED_ADMIN_USER || 'admin';
const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

if (get('SELECT id FROM users WHERE username = ?', [username])) {
  console.log(`User "${username}" already exists - skipping.`);
} else {
  run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hashPassword(password), 'admin']);
  console.log(`Created admin user "${username}" with password "${password}" - change this after first login.`);
}

if (get('SELECT id FROM users WHERE username = ?', ['viewer'])) {
  console.log('User "viewer" already exists - skipping.');
} else {
  run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['viewer', hashPassword('ChangeMe123!'), 'viewer']);
  console.log('Created viewer user "viewer" with password "ChangeMe123!" - change this after first login.');
}
