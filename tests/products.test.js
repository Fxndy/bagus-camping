const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-products-test-'));
const password = crypto.randomBytes(24).toString('hex');
const env = { ...process.env, DATA_DIR: directory, SESSION_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_USERNAME: 'products-admin', ADMIN_PASSWORD: password, COOKIE_SECURE: 'false' };
const defaultImage = '/assets/images/product-default.webp';
const productFields = { name: 'Tenda Uji Produk', category: 'Tenda', price: 32000, description: 'Perlengkapan untuk pengujian.' };
let child, base, adminCookie;

async function startServer() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server produk tidak siap.')), 15000);
    child.stdout.on('data', data => { if (String(data).includes('berjalan')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server produk berhenti: ${code}`)); });
  });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
}
async function stopServer() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
async function request(url, { method = 'GET', body, cookie = adminCookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${url}`, { method, headers, body: body === undefined || body instanceof FormData ? body : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
function savedState() { return JSON.parse(fs.readFileSync(path.join(directory, 'database.json'), 'utf8')); }
const tinyJpeg = async (color = '#b5c0aa') => sharp({ create: { width: 3, height: 2, channels: 3, background: color } }).jpeg().toBuffer();
function multipart(fields, file, mimeType = 'image/jpeg', filename = 'product.jpg') {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  if (file) form.append('image', new Blob([file], { type: mimeType }), filename);
  return form;
}
function adminHarness(order = {}) {
  const nodes = new Map();
  const listeners = {};
  const requests = [];
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { hidden: false, innerHTML: '', textContent: '', addEventListener() {} });
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners[type] = handler; }
  };
  const context = vm.createContext({
    document, FormData, URLSearchParams, URL, Event, setInterval: () => 1, clearInterval() {},
    location: { pathname: '/admin' }, window: { addEventListener() {}, dispatchEvent() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const responses = { '/api/admin/stats': {}, '/api/inventory': { inventory: [] }, '/api/admin/products': { products: [] }, '/api/admin/orders/1': { order } };
      return { ok: true, status: 200, json: async () => responses[url] || { orders: [], total: 0, page: 1, pageSize: 50 } };
    }
  });
  const source = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8').replace('  refresh();', '  globalThis.adminTest = { api, loadOrders, detailHtml };');
  vm.runInContext(source, context);
  return { context, nodes, listeners, requests, ...context.adminTest };
}
before(async () => {
  await startServer();
  const login = await request('/api/auth/login', { method: 'POST', cookie: null, body: { username: env.ADMIN_USERNAME, password } });
  assert.equal(login.status, 200);
  adminCookie = login.cookie;
});
after(async () => { await stopServer(); fs.rmSync(path.join(root, 'assets', 'uploads'), { recursive: true, force: true }); fs.rmSync(directory, { recursive: true, force: true }); });

test('unggahan produk menerima JPEG, PNG, dan WebP lalu menyimpan hasil WebP', async () => {
  const product = await request('/api/admin/products', { method: 'POST', body: productFields });
  assert.equal(product.status, 201);
  const id = product.data.product.id;
  const samples = [
    ['image/jpeg', await sharp({ create: { width: 9, height: 7, channels: 3, background: '#a35325' } }).jpeg().toBuffer(), 'jpeg'],
    ['image/png', await sharp({ create: { width: 9, height: 7, channels: 3, background: '#356a92' } }).png().toBuffer(), 'png'],
    ['image/webp', await sharp({ create: { width: 9, height: 7, channels: 3, background: '#558543' } }).webp().toBuffer(), 'webp']
  ];
  for (const [mimeType, bytes, format] of samples) {
    const body = multipart(productFields, bytes, mimeType, `photo.${format}`);
    const result = await request(`/api/admin/products/${id}`, { method: 'PATCH', body });
    assert.equal(result.status, 200, `${mimeType}: ${JSON.stringify(result.data)}`);
    assert.match(result.data.product.image, /^\/assets\/uploads\/products\/[a-f0-9]{48}\.webp$/);
    const response = await fetch(base + result.data.product.image);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/webp/);
    assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, 'webp');
  }
});

test('unggahan produk memvalidasi gambar nyata, mengganti foto dan menghapus artefak foto yang ditinggalkan', async () => {
  const input = await tinyJpeg();
  const created = await request('/api/admin/products', { method: 'POST', body: multipart(productFields, input) });
  assert.equal(created.status, 201);
  const originalUrl = created.data.product.image;
  assert.match(originalUrl, /^\/(?:assets\/)?uploads\/products\/[a-f0-9]{48}\.webp$/);
  const uploadDir = path.join(directory, 'uploads', 'products');
  const originalFilename = path.basename(originalUrl);
  const sourceAsset = path.join(root, 'assets', 'uploads', 'products', originalFilename);
  fs.mkdirSync(path.dirname(sourceAsset), { recursive: true });
  fs.writeFileSync(sourceAsset, 'shared source asset');
  assert.ok(fs.existsSync(path.join(uploadDir, originalFilename)));
  assert.ok(fs.existsSync(sourceAsset));
  const invalid = await request('/api/admin/products', { method: 'POST', body: multipart(productFields, Buffer.from('not an image')) });
  assert.equal(invalid.status, 400);
  const update = await request(`/api/admin/products/${created.data.product.id}`, { method: 'PATCH', body: multipart({ ...productFields, name: 'Foto Diganti' }, await tinyJpeg('#483322')) });
  assert.equal(update.status, 200);
  assert.notEqual(update.data.product.image, originalUrl);
  assert.equal(fs.existsSync(path.join(uploadDir, originalFilename)), false);
  assert.equal(fs.existsSync(sourceAsset), true);
  fs.rmSync(path.join(root, 'assets', 'uploads'), { recursive: true, force: true });
  const metadata = await sharp(fs.readFileSync(path.join(uploadDir, path.basename(update.data.product.image)))).metadata();
  assert.equal(metadata.format, 'webp');
  const replacementUrl = update.data.product.image;
  const reset = await request(`/api/admin/products/${created.data.product.id}`, { method: 'PATCH', body: multipart({ ...productFields, resetImage: 'true' }) });
  assert.equal(reset.data.product.image, defaultImage);
  assert.equal(fs.existsSync(path.join(uploadDir, path.basename(replacementUrl))), false);
  const removed = await request(`/api/admin/products/${created.data.product.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
});

test('admin mengirim FormData tanpa header JSON agar boundary multipart dibuat browser', async () => {
  const app = adminHarness();
  const body = new FormData();
  body.append('name', productFields.name);
  await app.api('/api/admin/products', { method: 'POST', body });
  assert.equal(app.requests[0].options.headers['Content-Type'], undefined);
  assert.equal(app.requests[0].options.body, body);
  await app.api('/api/admin/products', { method: 'POST', body: JSON.stringify(productFields) });
  assert.equal(app.requests[1].options.headers['Content-Type'], 'application/json');
});

test('dialog admin menyediakan satu unggahan foto, preview, dan reset tanpa input URL', async () => {
  const app = adminHarness();
  await app.loadOrders();
  const html = app.nodes.get('#adminDashboard').innerHTML;
  assert.match(html, /type="file"[^>]*name="image"/);
  assert.match(html, /accept="\.jpg,\.jpeg,\.png,\.webp,image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /id="productImagePreview"/);
  assert.match(html, /id="resetProductImage"/);
  assert.doesNotMatch(html, /URL gambar/);
  assert.doesNotMatch(html, /multiple/);
});

test('admin menampilkan bukti terlindungi tanpa memverifikasi pembayaran otomatis', async () => {
  const order = { id: 1, invoice_id: 'BAG-TEST-0001', items: [], total_amount: 32000, payment_status: 'pending_verification', paymentProofUrl: '/api/orders/BAG-TEST-0001/payment-proof' };
  const app = adminHarness(order);
  const html = await app.detailHtml(1);
  assert.match(html, /src="\/api\/orders\/BAG-TEST-0001\/payment-proof"/);
  assert.match(html, /href="\/api\/orders\/BAG-TEST-0001\/payment-proof"/);
  assert.match(html, /data-payment-action="confirm"/);
  assert.equal(app.requests.length, 1);
  order.payment_status = 'paid';
  assert.doesNotMatch(await app.detailHtml(1), /data-payment-action="confirm"/);
  order.paymentProofUrl = 'https://external.invalid/receipt.png';
  assert.doesNotMatch(await app.detailHtml(1), /external\.invalid/);
});

test('server menolak penghapusan produk yang masih disewa', async () => {
  const product = await request('/api/admin/products', { method: 'POST', body: productFields });
  const file = savedState();
  file.orders.push({ id: 9001, order_status: 'active' });
  file.orderItems.push({ id: 9001, order_id: 9001, product_id: product.data.product.id });
  fs.writeFileSync(path.join(directory, 'database.json'), JSON.stringify(file));
  await stopServer();
  await startServer();
  const denied = await request(`/api/admin/products/${product.data.product.id}`, { method: 'DELETE' });
  assert.equal(denied.status, 409);
  assert.ok((await request('/api/admin/products')).data.products.some(item => item.id === product.data.product.id));
});

test('produk baru tanpa foto memakai gambar bawaan dan tetap ada setelah restart', async () => {
  const anonymous = await request('/api/auth/register', { method: 'POST', cookie: null, body: { fullName: 'Pengguna Produk', username: 'products-customer', password } });
  assert.equal(anonymous.status, 201);
  assert.equal((await request('/api/admin/products', { cookie: anonymous.cookie })).status, 403);
  const arbitraryImage = await request('/api/admin/products', { method: 'POST', body: { ...productFields, image: 'https://external.invalid/photo.jpg' } });
  assert.equal(arbitraryImage.status, 201);
  assert.equal(arbitraryImage.data.product.image, defaultImage);
  const created = await request('/api/admin/products', { method: 'POST', body: productFields });
  assert.equal(created.status, 201);
  assert.equal(created.data.product.image, defaultImage);
  const id = created.data.product.id;
  const edited = await request(`/api/admin/products/${id}`, { method: 'PATCH', body: { ...productFields, name: 'Tenda Produk Diperbarui' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.product.image, defaultImage);
  assert.equal(edited.data.product.name, 'Tenda Produk Diperbarui');
  assert.equal((await request(`/api/admin/products/${id}`, { method: 'PATCH', body: { ...productFields, resetImage: 'true' } })).data.product.image, defaultImage);
  assert.equal((await request('/api/admin/products', { cookie: null })).status, 401);
  assert.equal((await request('/api/admin/products', { cookie: null, method: 'POST', body: productFields })).status, 401);
  assert.equal((await request('/api/admin/products/not-an-id', { method: 'PATCH', body: productFields })).status, 404);
  assert.equal((await request('/api/admin/products', { method: 'POST', body: { ...productFields, price: -2 } })).status, 400);
  assert.equal((await request('/api/admin/products', { method: 'POST', body: { ...productFields, name: 'A'.repeat(81) } })).status, 400);
  assert.equal((await request('/api/admin/products', { method: 'POST', body: multipart(productFields, Buffer.alloc(5 * 1024 * 1024 + 1)) })).status, 413);
  assert.equal(savedState().products.find(product => product.id === id)?.name, productFields.name);
  assert.equal(savedState().inventory[id], 0);
  await stopServer();
  await startServer();
  const catalog = await request('/api/admin/products');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.products.find(product => product.id === id), created.data.product);
  assert.equal((await request('/api/products', { cookie: null })).data.products.find(product => product.id === id)?.image, defaultImage);
});
