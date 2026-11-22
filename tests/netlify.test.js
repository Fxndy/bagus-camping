const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const sharp = require('sharp');

process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.ADMIN_USERNAME = 'netlifyadmin';
process.env.ADMIN_PASSWORD = randomBytes(16).toString('hex');

function memoryStore() {
  const entries = new Map();
  let version = 0;
  return {
    async getWithMetadata(key) { return structuredClone(entries.get(key) ?? null); },
    async get(key) { return structuredClone(entries.get(key)?.data ?? null); },
    async setJSON(key, data, opts = {}) { return this.set(key, data, opts); },
    async set(key, data, { onlyIfNew, onlyIfMatch } = {}) {
      const current = entries.get(key);
      if ((onlyIfNew && current) || (onlyIfMatch && current?.etag !== onlyIfMatch)) return { modified: false };
      const etag = `"${++version}"`;
      entries.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    async delete(key) { entries.delete(key); }
  };
}

test('Netlify handler persists sessions, inventory and private receipts across invocations without overselling', async () => {
  const { handle } = await import('../netlify/functions/api.js');
  const stores = { database: memoryStore(), sessions: memoryStore(), media: memoryStore() };
  const image = await sharp({ create: { width: 5, height: 5, channels: 3, background: 'white' } }).png().toBuffer();
  async function request(path, { method = 'GET', body, cookie, key } = {}) {
    const multipart = body instanceof FormData;
    const req = new Request(`https://test.netlify.app${path}`, {
      method, body: multipart ? body : body && JSON.stringify(body),
      headers: { ...(body && !multipart ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key } : {}), ...(method !== 'GET' ? { origin: 'https://test.netlify.app' } : {}) }
    });
    const response = await handle(req, { ip: '192.0.2.1' }, stores);
    return { status: response.status, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0], data: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  const admin = await request('/api/auth/login', { method: 'POST', body: { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD } });
  assert.equal(admin.status, 200, JSON.stringify(admin.data));
  assert.match(admin.headers.get('set-cookie'), /; Secure/i);
  const customer = await request('/api/auth/register', { method: 'POST', body: { username: 'netlifycustomer', fullName: 'Pelanggan Uji', password: process.env.ADMIN_PASSWORD } });
  assert.equal(customer.status, 201, JSON.stringify(customer.data));
  assert.equal((await request('/api/auth/me', { cookie: customer.cookie })).data.user.role, 'customer');
  assert.equal((await request('/api/admin/stats', { cookie: customer.cookie })).status, 403);
  assert.equal((await request('/api/admin/inventory/1', { method: 'PATCH', cookie: admin.cookie, body: { quantity: 1 } })).status, 200);
  const form = () => { const data = new FormData(); data.set('payload', JSON.stringify({ fullName: 'Pelanggan Uji', phone: '081234567890', rentalDays: 1, paymentMethod: 'SeaBank', items: [{ id: 1, quantity: 1 }] })); data.set('paymentProof', new Blob([image], { type: 'image/png' }), 'proof.png'); return data; };
  const orders = await Promise.all([1, 2].map(() => request('/api/orders', { method: 'POST', cookie: customer.cookie, body: form(), key: randomBytes(24).toString('hex') })));
  assert.deepEqual(orders.map(result => result.status).sort(), [201, 409], JSON.stringify(orders.map(x => x.data)));
  const proof = orders.find(x => x.status === 201).data.order.paymentProofUrl;
  assert.equal((await request(proof)).status, 404);
  const receipt = await request(proof, { cookie: customer.cookie });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.toString('ascii', 8, 12), 'WEBP');
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: customer.cookie })).status, 200);
  assert.equal((await request('/api/auth/me', { cookie: customer.cookie })).data.user, null);
});
