const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { state, persist } = require('./database');
const { maxRentalDays, paymentMethods } = require('./settings');
const inventory = require('./inventory');
const { imageUpload, saveImage, removeImage, readImage } = require('./media');

const router = express.Router();
const adminRouter = express.Router();
const orderLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Terlalu banyak permintaan. Coba kembali beberapa menit lagi.' } });
const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
let mutationQueue = Promise.resolve();
const serializedMutation = handler => asyncHandler(async (req, res) => {
  let release;
  const previous = mutationQueue;
  mutationQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try { await handler(req, res); } finally { release(); }
});

const orderLabels = { pending_approval: 'Menunggu Persetujuan', approved: 'Pesanan Disetujui', waiting_pickup: 'Menunggu Penjemputan', active: 'Sedang Disewa', completed: 'Selesai', rejected: 'Ditolak', cancelled: 'Dibatalkan' };
const paymentLabels = { unpaid: 'Belum Dibayar', pending_verification: 'Menunggu Verifikasi', paid: 'Pembayaran Terverifikasi', rejected: 'Pembayaran Ditolak' };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tokenKey = process.env.SESSION_SECRET;
const tokenFor = key => crypto.createHmac('sha256', tokenKey).update(`guest-order:${key}`).digest('hex');
const legacyTokenFor = key => crypto.createHmac('sha256', tokenKey).update(`guest-order:${key}`).digest('base64url');
const replayTokenFor = (key, order) => {
  const current = tokenFor(key);
  return hash(current) === order.access_token_hash ? current : legacyTokenFor(key);
};
const currentUser = req => req.session.user && state.users.find(user => user.id === req.session.user.id);
function adminOnly(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Silakan masuk terlebih dahulu.' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Akses khusus administrator.' });
  req.admin = user;
  next();
}
function findOrder(id) { return /^\d+$/.test(String(id)) ? state.orders.find(order => order.id === Number(id)) : state.orders.find(order => order.invoice_id === id); }
function authorized(req, row) {
  const user = currentUser(req);
  if (row.user_id !== null && row.user_id !== undefined) return user?.id === row.user_id;
  if (user) return false;
  const token = req.get('x-order-token');
  if (typeof token !== 'string' || token.length > 256 || !/^[a-f0-9]{64}$/.test(row.access_token_hash || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(row.access_token_hash, 'hex'));
}
function shapeOrder(row, admin = false) {
  const { access_token_hash, checkout_key_hash, checkout_payload_hash, payment_proof, ...order } = row;
  order.paymentProofUrl = payment_proof ? `/api/orders/${encodeURIComponent(row.invoice_id)}/payment-proof` : null;
  order.items = state.orderItems.filter(item => item.order_id === row.id).sort((a,b)=>a.id-b.id).map(item=>({productId:item.product_id,productName:item.product_name,quantity:item.quantity,dailyPrice:item.daily_price,subtotal:item.subtotal}));
  order.statusLabel = orderLabels[row.order_status];
  order.paymentStatusLabel = paymentLabels[row.payment_status];
  order.overdue = row.order_status === 'active' && Boolean(row.rental_end_at) && Date.now() > Date.parse(row.rental_end_at);
  order.returned_late = Boolean(row.returned_at && row.rental_end_at && Date.parse(row.returned_at) > Date.parse(row.rental_end_at));
  order.verifiedByName = state.users.find(user=>user.id===row.verified_by)?.full_name || null;
  if (admin) {
    order.history = state.orderStatusHistory.filter(entry=>entry.order_id===row.id).sort((a,b)=>a.id-b.id).map(entry=>({...entry,changedByName:state.users.find(user=>user.id===entry.changed_by)?.full_name||null}));
    order.paymentHistory = state.paymentHistory.filter(entry=>entry.order_id===row.id).sort((a,b)=>a.id-b.id).map(entry=>({...entry,changedByName:state.users.find(user=>user.id===entry.changed_by)?.full_name||null}));
  }
  return order;
}
const responseOrder = (res,row,admin=false) => res.json({order:shapeOrder(row,admin),serverNow:new Date().toISOString()});
function fail(status,message) { const error=new Error(message); error.status=status; throw error; }
function reserveInvoice(now) {
  const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const part=type=>date.find(entry=>entry.type===type).value;
  const day=`${part('year')}-${part('month')}-${part('day')}`;
  state.invoiceSequences[day]=(state.invoiceSequences[day]||0)+1;
  return `BAG-${day.replaceAll('-','')}-${String(state.invoiceSequences[day]).padStart(4,'0')}`;
}
function checkoutPayload(body) {
  const products = inventory.products;
  const fullName=typeof body.fullName==='string'?body.fullName.trim():'';
  const phone=typeof body.phone==='string'?body.phone.trim():'';
  const note=typeof body.note==='string'?body.note.trim():'';
  if(fullName.length<2||fullName.length>80)fail(400,'Nama harus berisi 2–80 karakter.');
  if(!/^[+0-9][0-9\s().-]{7,19}$/.test(phone))fail(400,'Nomor WhatsApp tidak valid.');
  if(!Number.isSafeInteger(body.rentalDays)||body.rentalDays<1||body.rentalDays>maxRentalDays)fail(400,`Durasi sewa harus bilangan bulat 1–${maxRentalDays} hari.`);
  if(!paymentMethods.some(method=>method.value===body.paymentMethod))fail(400,'Pilih SeaBank atau GoPay.');
  if(note.length>500||(body.note!==undefined&&typeof body.note!=='string'))fail(400,'Catatan maksimal 500 karakter.');
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>products.length)fail(400,'Pilih 1–12 jenis perlengkapan.');
  const seen=new Set();
  const items=body.items.map(item=>{if(!products.some(product=>product.id===item?.id)||seen.has(item.id)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>99)fail(400,'Rincian atau jumlah perlengkapan tidak valid.');seen.add(item.id);return{id:item.id,quantity:item.quantity};}).sort((a,b)=>a.id-b.id);
  return {fullName,phone,note,rentalDays:body.rentalDays,paymentMethod:body.paymentMethod,items};
}
router.post('/',orderLimit,(req,res,next)=>{if(!currentUser(req))return res.status(401).json({error:'Masuk terlebih dahulu sebelum memesan.'});next();},imageUpload('paymentProof'),serializedMutation(async(req,res)=>{
  const products = inventory.products;
  let body = req.body || {};
  if (typeof body.payload === 'string') { try { body = JSON.parse(body.payload); } catch { fail(400, 'Data pesanan tidak valid.'); } }
  else if (!Object.hasOwn(body, 'fullName') && req.get('content-type')?.startsWith('multipart/form-data')) fail(400, 'Data pesanan tidak valid.');
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Data pesanan tidak valid.');
  const payload=checkoutPayload(body),key=req.get('Idempotency-Key');
  if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{32,128}$/.test(key))fail(400,'Kunci pesanan tidak valid. Muat ulang halaman dan coba kembali.');
  const keyHash=hash(key),payloadHash=hash(JSON.stringify(payload)),user=currentUser(req);
  const previous=state.orders.find(order=>order.checkout_key_hash===keyHash);
  if(previous){if(previous.checkout_payload_hash!==payloadHash||previous.user_id!==(user?.id||null))fail(409,'Kunci pesanan sudah digunakan untuk data berbeda. Periksa invoice sebelum membuat pesanan baru.');return res.status(200).json({order:shapeOrder(previous),accessToken:replayTokenFor(key,previous),replayed:true,serverNow:new Date().toISOString()});}
  if (!req.file) fail(400, 'Bukti pembayaran wajib diunggah sebelum memesan.');
  for (const item of payload.items) if (item.quantity > inventory.available(item.id)) fail(409, `Stok ${products.find(product => product.id === item.id).name} tidak mencukupi. Stok tersedia saat ini ${inventory.available(item.id)}.`);
  const proof = await saveImage(req.file, 'proofs');
  const now=new Date().toISOString(),priced=payload.items.map(item=>{const product=products.find(entry=>entry.id===item.id);return{...item,name:product.name,dailyPrice:product.price,subtotal:product.price*item.quantity*payload.rentalDays};});
  const total=priced.reduce((sum,item)=>sum+item.subtotal,0);
  if(!Number.isSafeInteger(total))fail(400,'Total pesanan melampaui batas.');

  const counters = { nextOrderId: state.nextOrderId, nextItemId: state.nextItemId, nextStatusHistoryId: state.nextStatusHistoryId, nextPaymentHistoryId: state.nextPaymentHistoryId, invoiceSequences: { ...state.invoiceSequences } };
  const order={id:state.nextOrderId++,invoice_id:reserveInvoice(now),access_token_hash:hash(tokenFor(key)),checkout_key_hash:keyHash,checkout_payload_hash:payloadHash,user_id:user?.id||null,customer_name:payload.fullName,customer_phone:payload.phone,rental_days:payload.rentalDays,rental_start:null,rental_end:null,total_amount:total,payment_method:payload.paymentMethod,order_status:'pending_approval',payment_status:'pending_verification',payment_proof:{filename:proof.filename,kind:'proofs',uploadedAt:proof.uploadedAt},picked_up_at:null,rental_end_at:null,returned_at:null,created_at:now,updated_at:now,approved_by:null,approved_at:null,picked_up_by:null,returned_by:null,verified_at:null,verified_by:null,rejection_reason:null,note:payload.note};
  const firstItemId=state.nextItemId;
  state.orders.push(order);
  for(const item of priced)state.orderItems.push({id:state.nextItemId++,order_id:order.id,product_id:item.id,product_name:item.name,quantity:item.quantity,daily_price:item.dailyPrice,subtotal:item.subtotal});
  state.orderStatusHistory.push({id:state.nextStatusHistoryId++,order_id:order.id,previous_status:null,new_status:'pending_approval',changed_by:user?.id||null,changed_at:now,notes:'Pesanan dibuat; menunggu persetujuan admin.'});
  state.paymentHistory.push({id:state.nextPaymentHistoryId++,order_id:order.id,previous_status:null,new_status:'pending_verification',changed_by:user.id,changed_at:now,notes:'Bukti pembayaran diunggah saat checkout; menunggu verifikasi admin.'});
  try{await persist();}catch(error){
    state.paymentHistory=state.paymentHistory.filter(entry=>entry.order_id!==order.id);
    state.orders=state.orders.filter(entry=>entry.id!==order.id);
    state.orderItems=state.orderItems.filter(item=>item.order_id!==order.id);
    state.orderStatusHistory=state.orderStatusHistory.filter(entry=>entry.order_id!==order.id);
    Object.assign(state,{nextOrderId:counters.nextOrderId,nextItemId:counters.nextItemId,nextStatusHistoryId:counters.nextStatusHistoryId,nextPaymentHistoryId:counters.nextPaymentHistoryId});
    state.invoiceSequences=counters.invoiceSequences;
    await removeImage(proof).catch(()=>{});
    throw error;
  }
  res.status(201).json({order:shapeOrder(order),accessToken:tokenFor(key),replayed:false,serverNow:new Date().toISOString()});
}));
function myOrders(req,res){const user=currentUser(req);if(!user)fail(401,'Masuk untuk melihat riwayat pesanan.');res.json({orders:state.orders.filter(order=>order.user_id===user.id).sort((a,b)=>b.id-a.id).map(order=>shapeOrder(order)),serverNow:new Date().toISOString()});}
router.get('/mine',myOrders);
router.get('/:id/payment-proof',asyncHandler(async(req,res)=>{
  const row=findOrder(req.params.id);
  if(!row || (!authorized(req,row) && currentUser(req)?.role !== 'admin') || !/^[a-f0-9]{48}\.webp$/.test(row.payment_proof?.filename || '')) fail(404,'Bukti pembayaran tidak ditemukan atau akses tidak diizinkan.');
  const image = await readImage('proofs', row.payment_proof.filename);
  if (!image) fail(404, 'Bukti pembayaran tidak ditemukan.');
  res.set({'Cache-Control':'private, no-store','Content-Type':'image/webp','Content-Disposition':'inline; filename="bukti-pembayaran.webp"','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff'}).send(image);
}));
router.all('/:id/payment-proof',(req,res)=>res.set('Allow','GET, HEAD').status(405).json({error:'Metode permintaan tidak diizinkan.'}));
router.get('/:id',(req,res)=>{const row=findOrder(req.params.id);if(!row||!authorized(req,row))fail(404,'Invoice tidak ditemukan atau akses tidak diizinkan.');responseOrder(res,row);});
async function changePayment(id,action,actor,reason,customer=false){const row=findOrder(id);if(!row)fail(404,'Pesanan tidak ditemukan.');const rules={report:{from:['unpaid','rejected'],to:'pending_verification'},confirm:{from:['pending_verification'],to:'paid'},reject:{from:['pending_verification'],to:'rejected'}};const rule=Object.hasOwn(rules,action)?rules[action]:null;if(!rule||(customer&&action!=='report'))fail(400,'Tindakan pembayaran tidak valid.');if(!rule.from.includes(row.payment_status))fail(409,'Perubahan status pembayaran tidak diizinkan.');if(action==='report'&&['cancelled','rejected','completed'].includes(row.order_status))fail(409,'Pesanan sudah selesai, ditolak, atau dibatalkan.');const notes=typeof reason==='string'?reason.trim():'';if(notes.length>500||(action==='reject'&&notes.length<3))fail(400,'Alasan penolakan harus 3–500 karakter.');const before={...row},now=new Date().toISOString();row.payment_status=rule.to;row.updated_at=now;row.verified_at=action==='confirm'?now:null;row.verified_by=action==='confirm'?actor:null;row.rejection_reason=action==='reject'?notes:null;state.paymentHistory.push({id:state.nextPaymentHistoryId++,order_id:row.id,previous_status:before.payment_status,new_status:rule.to,changed_by:actor,changed_at:now,notes:notes||(customer?'Pelanggan melaporkan pembayaran; belum diverifikasi.':'Pemeriksaan pembayaran manual oleh admin.')});try{await persist();}catch(error){Object.assign(row,before);state.paymentHistory.pop();throw error;}return row;}
router.post('/:id/payment-report',orderLimit,serializedMutation(async(req,res)=>{const row=findOrder(req.params.id);if(!row||!authorized(req,row))fail(404,'Invoice tidak ditemukan atau akses tidak diizinkan.');responseOrder(res,await changePayment(row.id,'report',currentUser(req)?.id||null,'',true));}));
adminRouter.use(adminOnly);

adminRouter.get('/products',(req,res)=>res.status(410).json({error:'Endpoint produk dipindahkan.'}));
adminRouter.post('/products',(req,res)=>res.status(410).json({error:'Endpoint produk dipindahkan.'}));
adminRouter.patch('/products/:id',(req,res)=>res.status(410).json({error:'Endpoint produk dipindahkan.'}));
adminRouter.delete('/products/:id',(req,res)=>res.status(410).json({error:'Endpoint produk dipindahkan.'}));
adminRouter.get('/products/public',(req,res)=>res.json({products: inventory.products}));
adminRouter.get('/stats',(req,res)=>{const orders=state.orders;res.json({totalOrders:orders.length,pendingApproval:orders.filter(x=>x.order_status==='pending_approval').length,waitingPickup:orders.filter(x=>x.order_status==='waiting_pickup').length,activeRentals:orders.filter(x=>x.order_status==='active').length,completed:orders.filter(x=>x.order_status==='completed').length,overdue:orders.filter(x=>x.order_status==='active'&&Date.parse(x.rental_end_at)<Date.now()).length,confirmedPayments:orders.filter(x=>x.payment_status==='paid').length,awaitingVerification:orders.filter(x=>x.payment_status==='pending_verification').length,confirmedRevenue:orders.filter(x=>x.payment_status==='paid').reduce((sum,x)=>sum+x.total_amount,0),serverNow:new Date().toISOString()});});
adminRouter.get('/orders',(req,res)=>{const search=typeof req.query.search==='string'?req.query.search.slice(0,100).toLowerCase():'';const status=typeof req.query.status==='string'?req.query.status:'';const payment=typeof req.query.paymentStatus==='string'?req.query.paymentStatus:'';if((status&&!Object.hasOwn(orderLabels,status))||(payment&&!Object.hasOwn(paymentLabels,payment)))fail(400,'Filter status tidak valid.');const page=Math.max(1,Math.min(100000,Number.parseInt(req.query.page,10)||1)),pageSize=50;const filtered=state.orders.filter(order=>(!search||order.invoice_id.toLowerCase().includes(search)||order.customer_name.toLowerCase().includes(search)||order.customer_phone.toLowerCase().includes(search))&&(!status||order.order_status===status)&&(!payment||order.payment_status===payment)).sort((a,b)=>b.id-a.id);res.json({orders:filtered.slice((page-1)*pageSize,page*pageSize).map(order=>shapeOrder(order)),total:filtered.length,page,pageSize,serverNow:new Date().toISOString()});});
adminRouter.get('/orders/:id',(req,res)=>{const row=findOrder(req.params.id);if(!row)fail(404,'Pesanan tidak ditemukan.');responseOrder(res,row,true);});
const transitions={approve:{from:['pending_approval'],to:'approved',note:'Pesanan disetujui admin.'},reject:{from:['pending_approval'],to:'rejected',note:'Pesanan ditolak admin.'},'ready-pickup':{from:['approved'],to:'waiting_pickup',note:'Barang siap diambil.'},'confirm-pickup':{from:['waiting_pickup'],to:'active',note:'Pengambilan fisik dikonfirmasi; timer sewa dimulai.'},'confirm-return':{from:['active'],to:'completed',note:'Pengembalian fisik dikonfirmasi.'},cancel:{from:['pending_approval','approved','waiting_pickup'],to:'cancelled',note:'Pesanan dibatalkan sebelum pengambilan.'}};
async function changeOrder(id,action,adminId){const row=findOrder(id),rule=Object.hasOwn(transitions,action)?transitions[action]:null;if(!row)fail(404,'Pesanan tidak ditemukan.');if(!rule||!rule.from.includes(row.order_status))fail(409,'Perubahan status pesanan tidak diizinkan. Muat ulang detail pesanan.');const before={...row},now=new Date().toISOString();row.order_status=rule.to;row.updated_at=now;if(action==='approve'){row.approved_by=adminId;row.approved_at=now;}if(action==='confirm-pickup'){row.picked_up_at=now;row.rental_end_at=new Date(Date.parse(now)+row.rental_days*86400000).toISOString();row.picked_up_by=adminId;}if(action==='confirm-return'){row.returned_at=now;row.returned_by=adminId;}const entry={id:state.nextStatusHistoryId++,order_id:row.id,previous_status:before.order_status,new_status:rule.to,changed_by:adminId,changed_at:now,notes:rule.note};state.orderStatusHistory.push(entry);try{await persist();}catch(error){Object.assign(row,before);state.orderStatusHistory.pop();throw error;}return row;}
for(const action of Object.keys(transitions))adminRouter.patch(`/orders/:id/${action}`,serializedMutation(async(req,res)=>responseOrder(res,await changeOrder(req.params.id,action,req.admin.id),true)));
adminRouter.patch('/orders/:id/payment',serializedMutation(async(req,res)=>responseOrder(res,await changePayment(req.params.id,req.body?.action,req.admin.id,req.body?.reason),true)));
module.exports={router,adminRouter,myOrders,adminOnly};
