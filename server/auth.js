const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { state, persist } = require('./database');

const router = express.Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak percobaan. Silakan coba kembali beberapa menit lagi.' } });
const publicUser = user => ({ id: user.id, fullName: user.full_name, username: user.username, role: user.role });
const findUser = username => state.users.find(user => user.username.toLowerCase() === username.toLowerCase());
const usernameReservations = new Set();
const reservedUsername = value => value.toLowerCase();
const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const reserveRegistration = handler => asyncHandler(async (req, res, next) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const key = reservedUsername(username);
  if (usernameReservations.has(key) || findUser(username)) return res.status(409).json({ error: 'Username sudah digunakan.' });
  usernameReservations.add(key);
  try { await handler(req, res, next); } finally { usernameReservations.delete(key); }
});
const createUser = async (fullName, username, password) => {
  const passwordHash = await bcrypt.hash(password, 12);
  if (findUser(username)) return null;
  const user = { id: state.nextUserId++, full_name: fullName, username, password_hash: passwordHash, role: 'customer', created_at: new Date().toISOString() };
  state.users.push(user);
  try { await persist(); return user; }
  catch (error) { state.users = state.users.filter(entry => entry !== user); state.nextUserId = user.id; throw error; }
};
const registerUser = async (req, res) => {
  const { fullName, username, password } = req.body || {};
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  const login = typeof username === 'string' ? username.trim() : '';
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Nama harus berisi 2–80 karakter.' });
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(login)) return res.status(400).json({ error: 'Username harus 3–24 karakter; gunakan huruf, angka, titik, garis bawah, atau tanda hubung.' });
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'Kata sandi minimal 8 karakter, maksimal 72 byte.' });
  const user = await createUser(name, login, password);
  if (!user) return res.status(409).json({ error: 'Username sudah digunakan.' });
  startSession(req, res, user, 201);
};
const registerRoute = reserveRegistration(registerUser);
function startSession(req, res, user, status = 200) {
  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: 'Sesi gagal dibuat. Silakan masuk kembali.' });
    req.session.user = { id: user.id };
    req.session.save(saveError => saveError ? res.status(500).json({ error: 'Sesi gagal disimpan. Silakan masuk kembali.' }) : res.status(status).json({ user: publicUser(user) }));
  });
}
router.post('/register', authLimit, registerRoute);
router.post('/login', authLimit, async (req, res, next) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  try {
    const user = findUser(username);
    if (!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Username atau kata sandi tidak sesuai.' });
    startSession(req, res, user);
  } catch (error) { next(error); }
});
router.post('/logout', (req, res) => req.session.destroy(error => {
  if (error) return res.status(500).json({ error: 'Tidak dapat mengakhiri sesi. Coba lagi.' });
  res.clearCookie('rimba.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path: '/' });
  res.json({ message: 'Anda telah keluar.' });
}));
router.get('/me', (req, res) => {
  const user = req.session.user && state.users.find(entry => entry.id === req.session.user.id);
  res.json({ user: user ? publicUser(user) : null });
});
module.exports = router;
