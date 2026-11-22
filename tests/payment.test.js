const { test } = require('node:test');
const assert = require('node:assert/strict');

test('checkout hanya menawarkan SeaBank dan GoPay dengan nomor tujuan resmi', () => {
  const { paymentMethods } = require('../server/settings');
  assert.deepEqual(paymentMethods.map(method => method.value), ['SeaBank', 'GoPay']);
  assert.equal(paymentMethods[0].accountNumber, '901144289647');
  assert.equal(paymentMethods[1].phoneNumber, '085777598395');
  assert.ok(paymentMethods.every(method => method.configured));
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');

test('bukti wajib, privat, tervalidasi, idempotent, dan bertahan setelah restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-payment-'));
  const password = crypto.randomBytes(20).toString('hex');
  const env = { ...process.env, DATA_DIR: directory, SESSION_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_USERNAME: 'proofadmin', ADMIN_PASSWORD: password, COOKIE_SECURE: 'false' };
  let child, base;
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  async function start() {
    const socket = net.createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server tidak siap')), 15000);
      child.stdout.on('data', data => { if (String(data).includes('berjalan')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server berhenti ${code}`)); });
    });
  }
  async function request(url, { method = 'GET', body, cookie, key, raw = false } = {}) {
    const multipart = body instanceof FormData;
    const headers = { ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) };
    const response = await fetch(base + url, { method, headers, body: body ? multipart ? body : JSON.stringify(body) : undefined });
    return { status: response.status, data: raw ? Buffer.from(await response.arrayBuffer()) : await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await start();
  const admin = await request('/api/auth/login', { method: 'POST', body: { username: 'proofadmin', password } });
  const owner = await request('/api/auth/register', { method: 'POST', body: { fullName: 'Penyewa Bukti', username: 'proofowner', password } });
  const outsider = await request('/api/auth/register', { method: 'POST', body: { fullName: 'Penyewa Lain', username: 'proofother', password } });
  assert.equal(owner.status, 201);
  await request('/api/admin/inventory/1', { method: 'PATCH', cookie: admin.cookie, body: { quantity: 1 } });
  const payload = { fullName: 'Penyewa Bukti', phone: '081234567890', rentalDays: 1, paymentMethod: 'SeaBank', items: [{ id: 1, quantity: 1 }] };
  const missing = await request('/api/orders', { method: 'POST', cookie: owner.cookie, key: crypto.randomBytes(32).toString('hex'), body: payload });
  assert.equal(missing.status, 400, 'checkout tanpa bukti harus ditolak');
  assert.match(missing.data.error, /bukti/i);
  const image = await sharp({ create: { width: 60, height: 80, channels: 3, background: '#d9d9d9' } }).png().toBuffer();
  const upload = (bytes = image, type = 'image/png', data = payload) => {
    const form = new FormData(); form.set('payload', JSON.stringify(data)); form.set('paymentProof', new Blob([bytes], { type }), 'bukti.png'); return form;
  };
  const bad = await request('/api/orders', { method: 'POST', cookie: owner.cookie, key: crypto.randomBytes(32).toString('hex'), body: upload(Buffer.from('<svg onload="alert(1)"></svg>')) });
  assert.equal(bad.status, 400);
  const tooLarge = await request('/api/orders', { method: 'POST', cookie: owner.cookie, key: crypto.randomBytes(32).toString('hex'), body: upload(Buffer.alloc(5 * 1024 * 1024 + 1)) });
  assert.equal(tooLarge.status, 413);
  const oldMethod = await request('/api/orders', { method: 'POST', cookie: owner.cookie, key: crypto.randomBytes(32).toString('hex'), body: upload(image, 'image/png', { ...payload, paymentMethod: 'QRIS' }) });
  assert.equal(oldMethod.status, 400);
  assert.equal((await request('/api/orders', { method: 'POST', key: crypto.randomBytes(32).toString('hex'), body: upload() })).status, 401);
  const key = crypto.randomBytes(32).toString('hex');
  const created = await request('/api/orders', { method: 'POST', cookie: owner.cookie, key, body: upload() });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const order = created.data.order;
  assert.equal(order.payment_status, 'pending_verification');
  assert.equal(order.verified_at, null);
  assert.equal(order.payment_proof, undefined, 'metadata berkas privat tidak boleh bocor');
  assert.match(order.paymentProofUrl, /^\/api\/orders\/.+\/payment-proof$/);
  const repeated = await request('/api/orders', { method: 'POST', cookie: owner.cookie, key, body: payload });
  assert.equal(repeated.status, 200, 'retry setelah stok terpakai tetap mengembalikan order sama');
  assert.equal(repeated.data.order.id, order.id);
  assert.equal((await request(order.paymentProofUrl, { raw: true })).status, 404);
  assert.equal((await request(order.paymentProofUrl, { cookie: outsider.cookie, raw: true })).status, 404);
  const proof = await request(order.paymentProofUrl, { cookie: owner.cookie, raw: true });
  assert.equal(proof.status, 200);
  assert.match(proof.headers.get('cache-control'), /no-store/);
  assert.equal((await sharp(proof.data).metadata()).format, 'webp');
  assert.equal((await request(order.paymentProofUrl, { cookie: admin.cookie, raw: true })).status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'database.json'), 'utf8'));
  assert.equal(saved.orders.length, 1); assert.equal(saved.paymentHistory[0].new_status, 'pending_verification');
  const files = fs.readdirSync(path.join(directory, 'uploads', 'proofs'));
  assert.equal(files.length, 1);
  assert.equal((await request(`/assets/uploads/proofs/${files[0]}`, { raw: true })).status, 404);
  await stop(); await start();
  assert.equal((await request(order.paymentProofUrl, { cookie: owner.cookie, raw: true })).status, 200);
  assert.equal((await request(`/api/admin/orders/${order.id}/payment`, { method: 'PATCH', cookie: outsider.cookie, body: { action: 'confirm' } })).status, 403);
  const confirmed = await request(`/api/admin/orders/${order.id}/payment`, { method: 'PATCH', cookie: admin.cookie, body: { action: 'confirm' } });
  assert.equal(confirmed.data.order.payment_status, 'paid');
});
