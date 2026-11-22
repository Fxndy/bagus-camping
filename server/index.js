const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { state, persist, currentRequest } = require('./database');
const settings = require('./settings');
const inventory = require('./inventory');
const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function serializeSession(value) {
  const data = { ...value };
  if (data.cookie?.expires) data.cookie = { ...data.cookie, expires: new Date(data.cookie.expires).toISOString() };
  return data;
}
function parseSession(value) {
  const data = JSON.parse(value);
  if (data.cookie?.expires) data.cookie.expires = new Date(data.cookie.expires);
  return data;
}
class JsonSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = state.sessions[sid];
      if (!row || row.expires_at <= Date.now()) { if (row) { delete state.sessions[sid]; persist().catch(() => {}); } return callback(null, null); }
      callback(null, parseSession(row.data));
    } catch (error) { callback(error); }
  }
  set(sid, value, callback = () => {}) {
    state.sessions[sid] = { data: JSON.stringify(serializeSession(value)), expires_at: value.cookie.expires ? Date.parse(value.cookie.expires) : Date.now() + 604800000 };
    for (const [id, record] of Object.entries(state.sessions)) if (record.expires_at <= Date.now()) delete state.sessions[id];
    persist().then(() => callback(null), callback);
  }
  destroy(sid, callback = () => {}) {
    delete state.sessions[sid];
    persist().then(() => callback(null), callback);
  }
  touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }
}
class BlobSessionStore extends session.Store {
  get(sid, callback) {
    currentRequest().sessions.get(sid, { type: 'json' }).then(row => {
      callback(null, row && row.expires_at > Date.now() ? row.data : null);
    }, callback);
  }
  set(sid, value, callback) {
    currentRequest().sessions.setJSON(sid, { data: serializeSession(value), expires_at: Date.parse(value.cookie.expires) }).then(() => callback(null), callback);
  }
  destroy(sid, callback) {
    currentRequest().sessions.delete(sid).then(() => callback(null), callback);
  }
}
function createApp({ netlify = false } = {}) {
  const app = express();
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET harus diisi dengan nilai acak minimal 32 karakter.');
  app.disable('x-powered-by');
  const trustProxySetting = netlify ? 'false' : process.env.TRUST_PROXY ?? 'false';
  const trustProxy = trustProxySetting === 'false' ? false : trustProxySetting === 'true' ? 1 : trustProxySetting;
  app.set('trust proxy', trustProxy);
  app.use((req, res, next) => {
    if (trustProxy === false) req.headers['x-forwarded-for'] = undefined;
    next();
  });
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      let foreign = req.get('Sec-Fetch-Site') === 'cross-site';
      if (origin) {
        try { foreign ||= new URL(origin).host !== req.get('host'); } catch { foreign = true; }
      }
      if (foreign) return res.status(403).json({ error: 'Permintaan harus berasal dari situs ini.' });
    }
    next();
  });
  app.use((req, res, next) => {
    if (req.is('multipart/form-data')) return next();
    express.json({ limit: '12kb' })(req, res, next);
  });
  app.use(session({
    name: 'rimba.sid', secret, store: netlify ? new BlobSessionStore() : new JsonSessionStore(), resave: false, saveUninitialized: false,
    ...(netlify && { proxy: true }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: netlify ? 'auto' : process.env.COOKIE_SECURE === 'true', maxAge: 604800000, path: '/' }
  }));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/checkout-config', (req, res) => res.json(settings));
  app.get('/api/inventory', (req, res) => res.json({ inventory: inventory.list() }));
  app.use('/api/auth', require('./auth'));
  const orderRoutes = require('./orders');
  const productRoutes = require('./products');
  app.get('/api/products', (req, res) => res.json({ products: inventory.products }));
  app.use('/api/admin/products', orderRoutes.adminOnly, productRoutes);
  app.patch('/api/admin/inventory/:productId', orderRoutes.adminOnly, asyncHandler(async (req, res) => {
    const result = await inventory.setStock(Number(req.params.productId), req.body?.quantity);
    res.status(result.status).json(result.status === 200 ? { inventory: result.inventory } : { error: result.error });
  }));
  app.get('/api/my/orders', orderRoutes.myOrders);
  app.use('/api/orders', orderRoutes.router);
  app.use('/api/admin', orderRoutes.adminRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
  const root = path.join(__dirname, '..');
  const { uploadsDir, readImage } = require('./media');
  if (netlify) {
    app.get('/assets/uploads/products/:filename', asyncHandler(async (req, res) => {
      const image = await readImage('products', req.params.filename);
      if (!image) return res.sendStatus(404);
      res.type('image/webp').set('Cache-Control', 'public, max-age=31536000, immutable').send(image);
    }));
  } else {
  app.use('/assets/uploads/products', express.static(path.join(uploadsDir, 'products'), { dotfiles: 'deny', index: false, fallthrough: false, immutable: true, maxAge: '1y', setHeaders(res, filePath) { const ext = path.extname(filePath).toLowerCase(); res.type(ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'image/webp'); res.set('X-Content-Type-Options', 'nosniff'); } }));
  for (const directory of ['css','js','assets']) app.use(`/${directory}`, express.static(path.join(root, directory), { dotfiles: 'deny' }));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
  app.get(['/','/index.html'], (req, res) => res.sendFile(path.join(root, 'index.html')));
  }
  app.use((req, res) => res.status(404).send('Halaman tidak ditemukan.'));
  app.use((error, req, res, next) => {
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error('Operasi server gagal:', error.code || error.name);
    res.status(status).json({ error: status === 500 ? 'Terjadi kesalahan pada server. Silakan coba kembali.' : error.type === 'entity.parse.failed' ? 'Data JSON tidak valid.' : error.message });
  });
  return app;
}
async function initNetlifyAdmin() {
  if (state.users.some(user => user.role === 'admin')) return;
  const username = process.env.ADMIN_USERNAME?.trim() || '';
  const password = process.env.ADMIN_PASSWORD || '';
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username) || password.length < 8 || Buffer.byteLength(password) > 72) {
    throw new Error('Konfigurasi administrator Netlify belum valid.');
  }
  if (state.users.some(user => user.username.toLowerCase() === username.toLowerCase())) throw new Error('Username administrator sudah digunakan.');
  const full_name = process.env.ADMIN_FULL_NAME?.trim() || 'Administrator';
  const password_hash = await require('bcryptjs').hash(password, 12);
  state.users.push({ id: state.nextUserId++, full_name, username, password_hash, role: 'admin', created_at: new Date().toISOString() });
  await persist();
}
async function start() {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  inventory.initialize();
  if (!state.users.some(user => user.role === 'admin')) {
    const bcrypt = require('bcryptjs');
    const fullName = process.env.ADMIN_FULL_NAME?.trim() || 'Administrator';
    const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin';
    const passwordHash = await bcrypt.hash(password, 12);
    state.users.push({ id: state.nextUserId++, full_name: fullName, username, password_hash: passwordHash, role: 'admin', created_at: new Date().toISOString() });
    await persist();
    console.warn('Admin awal dibuat. Ganti sandi admin bawaan segera sebelum situs dibuka ke publik.');
  }
  return app.listen(port, '0.0.0.0', () => console.log(`Bagus Adventure berjalan pada port ${port}`));
}
module.exports = { createApp, initNetlifyAdmin };
if (require.main === module) {
const serverReady = start();
let httpServer;
serverReady.then(server => { httpServer = server; }).catch(error => { console.error('Aplikasi gagal dijalankan:', error.message); process.exitCode = 1; });
process.on('SIGINT', () => httpServer?.close(() => persist().then(() => process.exit(0))));
process.on('SIGTERM', () => httpServer?.close(() => persist().then(() => process.exit(0))));
}
