const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bagus-rental-json-test-'));
const password = crypto.randomBytes(24).toString('hex');
const env = { ...process.env, DATA_DIR: directory, SESSION_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_USERNAME: 'testadmin', ADMIN_PASSWORD: password, COOKIE_SECURE: 'false', MAX_RENTAL_DAYS: '30' };
let child, base, adminCookie, proofBuffer;
async function startServer() {
  const socket = net.createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening');
  const port=socket.address().port; await new Promise(resolve=>socket.close(resolve)); base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server tidak siap.')),15000);child.stdout.on('data',data=>{if(String(data).includes('berjalan')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server berhenti: ${code}`));});child.stderr.on('data',data=>process.stderr.write(data));});
  assert.equal((await fetch(`${base}/api/health`)).status,200);
}
async function stopServer(){if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}}
after(async()=>{await stopServer();fs.rmSync(directory,{recursive:true,force:true});});
async function request(url,{method='GET',body,cookie,token,key,upload=false}={}){
  const headers={}; let requestBody;
  if(body!==undefined){
    if(upload){requestBody=new FormData();requestBody.set('payload',JSON.stringify(body));requestBody.set('paymentProof',new Blob([proofBuffer],{type:'image/png'}),'proof.png');}
    else{headers['Content-Type']='application/json';requestBody=JSON.stringify(body);}
  }
  if(cookie)headers.Cookie=cookie;if(token)headers['x-order-token']=token;if(key)headers['Idempotency-Key']=key;
  const response=await fetch(`${base}${url}`,{method,headers,body:requestBody});const contentType=response.headers.get('content-type')||'';return{status:response.status,data:contentType.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer()),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const checkout={fullName:'Penyewa Uji',phone:'081234567890',rentalDays:3,paymentMethod:'SeaBank',items:[{id:2,quantity:1},{id:4,quantity:2}]};
test('siklus penuh rental, pembayaran, JSON persisten dan keamanan otorisasi',async()=>{
  proofBuffer=await sharp({create:{width:32,height:32,channels:3,background:'#447788'}}).png().toBuffer();
  const init=spawnSync(process.execPath,['server/init-admin.js'],{cwd:root,env,encoding:'utf8'});assert.equal(init.status,0,init.stderr);await startServer();
  const login=await request('/api/auth/login',{method:'POST',body:{username:'testadmin',password}});assert.equal(login.status,200);adminCookie=login.cookie;
  const registration=await request('/api/auth/register',{method:'POST',body:{fullName:'Pelanggan Uji',username:'customer1',password}});assert.equal(registration.status,201);
  const customerCookie=registration.cookie;
  for (const item of await request('/api/inventory').then(result => result.data.inventory)) assert.equal((await request(`/api/admin/inventory/${item.id}`,{method:'PATCH',cookie:adminCookie,body:{quantity:10}})).status,200);
  const key=crypto.randomBytes(32).toString('hex');
  const duplicate=await Promise.all(Array.from({length:4},(_,index)=>request('/api/orders',{method:'POST',body:checkout,cookie:customerCookie,key,upload:index===0})));
  assert.deepEqual(duplicate.map(x=>x.status).sort(),[200,200,200,201]);
  const saved=duplicate[0].data.order,token=duplicate[0].data.accessToken,id=saved.id;
  assert.equal(saved.total_amount,195000);assert.equal(saved.order_status,'pending_approval');assert.equal(saved.payment_status,'pending_verification');assert.equal(saved.picked_up_at,null);assert.equal(saved.rental_end_at,null);
  let file=JSON.parse(fs.readFileSync(path.join(directory,'database.json'),'utf8'));assert.equal(file.orders.length,1);assert.equal(file.orderItems.length,2);assert.ok(file.sessions);
  const repeat=await request(`/api/orders/${saved.invoice_id}`,{cookie:customerCookie});assert.equal(repeat.status,200);
  const outsider=await request('/api/auth/register',{method:'POST',body:{fullName:'Akun Lain',username:'customer2',password}});
  assert.equal((await request(`/api/orders/${saved.invoice_id}/payment-proof`,{cookie:outsider.cookie})).status,404);
  assert.equal((await request(`/api/orders/${saved.invoice_id}`,{cookie:outsider.cookie,token})).status,404);
  assert.equal((await request(`/api/orders/${saved.invoice_id}`,{cookie:customerCookie})).status,200);
  assert.deepEqual((await request('/api/inventory')).data.inventory.map(item=>item.total),Array(12).fill(10));
  assert.equal((await request('/api/admin/inventory/2',{method:'PATCH',cookie:adminCookie,body:{quantity:1}})).status,200);
  assert.equal((await request('/api/orders',{method:'POST',body:checkout,cookie:customerCookie,key:crypto.randomBytes(32).toString('hex'),upload:true})).status,409);
  assert.equal((await request('/api/admin/inventory/2',{method:'PATCH',cookie:adminCookie,body:{quantity:10}})).status,200);
  const invalidDuration=await request('/api/orders',{method:'POST',body:{...checkout,rentalDays:1.2},cookie:customerCookie,key:crypto.randomBytes(32).toString('hex'),upload:true});assert.equal(invalidDuration.status,400);
  assert.equal((await request('/api/orders',{method:'POST',body:{...checkout,paymentMethod:'Bitcoin'},cookie:customerCookie,key:crypto.randomBytes(32).toString('hex'),upload:true})).status,400);
  assert.equal((await request('/api/admin/stats',{cookie:customerCookie})).status,403);
  assert.equal((await request('/api/admin/orders/'+id+'/approve',{method:'PATCH'})).status,401);
  assert.equal((await request('/api/admin/orders/'+id+'/payment',{method:'PATCH',cookie:adminCookie,body:{action:'confirm'}})).status,200);
  assert.equal((await request('/api/admin/orders/'+id+'/approve',{method:'PATCH',cookie:adminCookie})).data.order.order_status,'approved');
  assert.equal((await request('/api/admin/orders/'+id+'/ready-pickup',{method:'PATCH',cookie:adminCookie})).data.order.rental_end_at,null);
  const picked=await request('/api/admin/orders/'+id+'/confirm-pickup',{method:'PATCH',cookie:adminCookie,body:{picked_up_at:'1900-01-01T00:00:00Z'}});assert.equal(picked.status,200);
  assert.equal(Date.parse(picked.data.order.rental_end_at)-Date.parse(picked.data.order.picked_up_at),3*86400000);
  const duplicatePickup=await request('/api/admin/orders/'+id+'/confirm-pickup',{method:'PATCH',cookie:adminCookie});assert.equal(duplicatePickup.status,409);
  await stopServer();await startServer();
  const afterRestart=await request('/api/admin/orders/'+id,{cookie:adminCookie});assert.equal(afterRestart.status,200);assert.equal(afterRestart.data.order.rental_end_at,picked.data.order.rental_end_at);assert.equal(afterRestart.data.order.payment_status,'paid');
  assert.equal((await request(`/api/orders/${saved.invoice_id}/payment-proof`,{cookie:customerCookie})).status,200);
  const updatedDeadline=new Date(Date.now()-3600000).toISOString();file=JSON.parse(fs.readFileSync(path.join(directory,'database.json'),'utf8'));file.orders.find(order=>order.id===id).rental_end_at=updatedDeadline;fs.writeFileSync(path.join(directory,'database.json'),JSON.stringify(file));
  await stopServer();await startServer();
  const stats=await request('/api/admin/stats',{cookie:adminCookie});assert.equal(stats.data.overdue,1);assert.equal(stats.data.activeRentals,1);
  const returned=await request('/api/admin/orders/'+id+'/confirm-return',{method:'PATCH',cookie:adminCookie});assert.equal(returned.data.order.order_status,'completed');assert.equal(returned.data.order.returned_late,true);
  const finalFile=JSON.parse(fs.readFileSync(path.join(directory,'database.json'),'utf8'));assert.equal(finalFile.orders.find(order=>order.id===id).order_status,'completed');assert.ok(finalFile.orderStatusHistory.length>=5);assert.ok(finalFile.paymentHistory.length>=1);
});
