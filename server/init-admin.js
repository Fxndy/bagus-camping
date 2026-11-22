const bcrypt = require('bcryptjs');
const { state, persist } = require('./database');

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';
  const fullName = process.env.ADMIN_FULL_NAME?.trim() || 'Administrator';
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username) || fullName.length < 2 || fullName.length > 80) throw new Error('Nama atau username administrator tidak valid.');
  if (!password || password.length < 8 || Buffer.byteLength(password) > 72) throw new Error('Isi ADMIN_PASSWORD dengan minimal 8 karakter, maksimal 72 byte.');
  const hash = await bcrypt.hash(password, 12);
  const existing = state.users.find(user => user.username.toLowerCase() === username.toLowerCase());
  if (existing) { existing.full_name=fullName; existing.password_hash=hash; existing.role='admin'; }
  else state.users.push({id:state.nextUserId++,full_name:fullName,username,password_hash:hash,role:'admin',created_at:new Date().toISOString()});
  await persist();
  console.log('Akun administrator siap digunakan.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
