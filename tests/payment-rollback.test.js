const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');

test('checkout rollback restores invoice/history/order counters and removes uncommitted receipt', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-rollback-'));
  const password = crypto.randomBytes(20).toString('hex');
  const env = { ...process.env, DATA_DIR: directory, SESSION_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_USERNAME: 'rollbackadmin', ADMIN_PASSWORD: password, COOKIE_SECURE: 'false' };
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
  async function request(url, { method = 'GET', body, cookie, key } = {}) {
    const multipart = body instanceof FormData;
    const response = await fetch(base + url, { method, headers: { ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? multipart ? body : JSON.stringify(body) : undefined });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, data: type.includes('application/json') ? await response.json() : await response.text(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await start();
  const admin = await request('/api/auth/login', { method: 'POST', body: { username: 'rollbackadmin', password } });
  const customer = await request('/api/auth/register', { method: 'POST', body: { fullName: 'Penyewa Uji', username: 'rollbackcustomer', password } });
  assert.equal(admin.status, 200); assert.equal(customer.status, 201);
  await request('/api/admin/inventory/1', { method: 'PATCH', cookie: admin.cookie, body: { quantity: 1 } });
  const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#d6e2d6' } }).png().toBuffer();
  const payload = { fullName: 'Penyewa Uji', phone: '081234567890', rentalDays: 1, paymentMethod: 'SeaBank', items: [{ id: 1, quantity: 1 }] };
  const form = () => { const result = new FormData(); result.set('payload', JSON.stringify(payload)); result.set('paymentProof', new Blob([image], { type: 'image/png' }), 'proof.png'); return result; };
  const database = path.join(directory, 'database.json'), original = path.join(directory, 'database.saved');
  fs.renameSync(database, original);
  fs.mkdirSync(database);
  const failed = await request('/api/orders', { method: 'POST', cookie: customer.cookie, key: crypto.randomBytes(32).toString('hex'), body: form() });
  assert.equal(failed.status, 500);
  assert.equal((await request('/api/my/orders', { cookie: customer.cookie })).data.orders.length, 0);
  assert.equal(fs.readdirSync(path.join(directory, 'uploads', 'proofs')).length, 0);
  fs.rmSync(database, { recursive: true, force: true }); fs.renameSync(original, database);
  const success = await request('/api/orders', { method: 'POST', cookie: customer.cookie, key: crypto.randomBytes(32).toString('hex'), body: form() });
  assert.equal(success.status, 201, JSON.stringify(success.data));
  const saved = JSON.parse(fs.readFileSync(database, 'utf8'));
  assert.deepEqual(Object.values(saved.invoiceSequences), [1]);
  assert.equal(saved.orders.length, 1); assert.equal(saved.orderStatusHistory.length, 1); assert.equal(saved.paymentHistory.length, 1);
  assert.equal(saved.nextOrderId, 2); assert.equal(saved.nextItemId, 2); assert.equal(saved.nextStatusHistoryId, 2); assert.equal(saved.nextPaymentHistoryId, 2);
});
