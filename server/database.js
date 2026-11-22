const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const filePath = path.join(dataDir, 'database.json');
const initialState = () => ({ users: [], orders: [], orderItems: [], orderStatusHistory: [], paymentHistory: [], invoiceSequences: {}, sessions: {}, orderTokenKey: crypto.randomBytes(32).toString('hex'), nextUserId: 1, nextOrderId: 1, nextItemId: 1, nextStatusHistoryId: 1, nextPaymentHistoryId: 1 });
function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Format penyimpanan JSON tidak valid.');
  const state = { ...initialState(), ...value };
  for (const key of ['users','orders','orderItems']) if (!Array.isArray(state[key])) throw new Error(`Data ${key} tidak valid.`);
  if (!state.invoiceSequences || typeof state.invoiceSequences !== 'object' || Array.isArray(state.invoiceSequences)) state.invoiceSequences = {};
  if (!Array.isArray(state.orderStatusHistory)) state.orderStatusHistory = [];
  if (!Array.isArray(state.paymentHistory)) state.paymentHistory = [];
  if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) state.sessions = {};
  state.nextUserId = Math.max(Number(state.nextUserId)||1, ...state.users.map(user => Number(user.id)+1||1));
  state.nextOrderId = Math.max(Number(state.nextOrderId)||1, ...state.orders.map(order => Number(order.id)+1||1));
  state.nextItemId = Math.max(Number(state.nextItemId)||1, ...state.orderItems.map(item => Number(item.id)+1||1));
  state.nextStatusHistoryId = Math.max(Number(state.nextStatusHistoryId)||1, ...state.orderStatusHistory.map(entry => Number(entry.id)+1||1));
  state.nextPaymentHistoryId = Math.max(Number(state.nextPaymentHistoryId)||1, ...state.paymentHistory.map(entry => Number(entry.id)+1||1));
  if (typeof state.orderTokenKey !== 'string' || !/^[a-f0-9]{64}$/.test(state.orderTokenKey)) state.orderTokenKey = crypto.randomBytes(32).toString('hex');
  return state;
}
let local;
function localState() {
  if (local) return local;
  fs.mkdirSync(dataDir, { recursive: true });
  try { local = validateState(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Gagal membaca ${filePath}: ${error.message}`);
    local = initialState();
  }
  return local;
}
const requests = new AsyncLocalStorage();
const currentRequest = () => requests.getStore();
const currentState = () => currentRequest()?.state ?? localState();
const state = new Proxy({}, {
  get: (_, key) => currentState()[key],
  set: (_, key, value) => Reflect.set(currentState(), key, value)
});
const databaseKey = 'database.json';
let sandboxQueue = Promise.resolve();
async function withBlobs(stores, run, sandbox = false) {
  if (sandbox) {
    const operation = sandboxQueue.then(() => readBlobs(stores, run, true));
    sandboxQueue = operation.catch(() => {});
    return operation;
  }
  return readBlobs(stores, run, false);
}
async function readBlobs(stores, run, sandbox) {
  const entry = await stores.database.getWithMetadata(databaseKey, { type: 'json' });
  if (entry && !entry.etag && !sandbox) throw new Error('ETag database tidak tersedia.');
  return requests.run({ ...stores, state: entry ? validateState(entry.data) : initialState(), etag: entry?.etag, sandbox, exists: Boolean(entry) }, run);
}
let writeQueue = Promise.resolve();
async function persist() {
  const request = currentRequest();
  if (request) {
    // ponytail: Netlify Dev omits GET ETags; its local sandbox is not a concurrency test.
    let conditions;
    if (request.etag) conditions = { onlyIfMatch: request.etag };
    else if (!request.exists) conditions = { onlyIfNew: true };
    else if (!request.sandbox) throw new Error('ETag database tidak tersedia.');
    const { modified, etag } = await request.database.setJSON(databaseKey, request.state, conditions);
    if (!modified) throw Object.assign(new Error('Data baru saja berubah. Muat ulang lalu coba lagi.'), { status: 409, code: 'DATABASE_CONFLICT' });
    request.etag = etag;
    request.exists = true;
    return;
  }
  const snapshot = JSON.stringify(localState(), null, 2);
  const operation = writeQueue.then(async () => {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporaryPath, filePath);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
function transaction(callback) {
  const target = currentState();
  const before = structuredClone(target);
  const rollback = () => { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, before); };
  try {
    const result = callback();
    return Promise.resolve(result).then(async value => { await persist(); return value; }).catch(error => { rollback(); throw error; });
  } catch (error) {
    rollback();
    return Promise.reject(error);
  }
}
module.exports = { state, persist, transaction, filePath, currentRequest, withBlobs, databaseKey, validateState };
