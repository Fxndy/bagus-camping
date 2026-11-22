const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('store JSON memulihkan seluruh koleksi dan mempertahankan berkas sumber', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-json-store-'));
  try {
    const fixture = { users: [{ id: 4, username: 'uji', full_name: 'Uji', password_hash: 'hash', role: 'customer', created_at: new Date().toISOString() }], orders: [{ id: 9, invoice_id: 'BAG-20261121-0009', user_id: 4, order_status: 'active', payment_status: 'unpaid', rental_days: 3, total_amount: 99000 }], orderItems: [{ id: 2, order_id: 9, product_id: 2, product_name: 'Tenda', quantity: 1, daily_price: 33000, subtotal: 99000 }], orderStatusHistory: [{ id: 1, order_id: 9, new_status: 'active' }], paymentHistory: [], invoiceSequences: { '2026-11-21': 9 }, sessions: { sid: { data: '{}', expires_at: Date.now() + 10000 } }, nextUserId: 5, nextOrderId: 10, nextItemId: 3, nextStatusHistoryId: 2, nextPaymentHistoryId: 1 };
    const source = path.join(dir, 'database.json');
    fs.writeFileSync(source, JSON.stringify(fixture));
    const script = `const {state,persist}=require('./server/database');if(state.orders[0].order_status!=='active'||state.sessions.sid.expires_at< Date.now())process.exit(2);state.orders[0].order_status='completed';persist().then(()=>process.exit(0),()=>process.exit(3));`;
    const env = { ...process.env, DATA_DIR: dir };
    assert.equal(spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env }).status, 0);
    assert.equal(spawnSync(process.execPath, ['-e', `const {state}=require('./server/database');if(state.orders[0].order_status!=='completed'||state.users[0].id!==4||state.orderItems[0].daily_price!==33000)process.exit(2);`], { cwd: path.resolve(__dirname, '..'), env }).status, 0);
    const saved = JSON.parse(fs.readFileSync(source, 'utf8'));
    assert.equal(saved.orders[0].order_status, 'completed');
    assert.equal(saved.users[0].username, 'uji');
    assert.equal(saved.orderItems[0].daily_price, 33000);
    assert.equal(saved.orderStatusHistory.length, 1);
    assert.match(saved.orderTokenKey, /^[a-f0-9]{64}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
