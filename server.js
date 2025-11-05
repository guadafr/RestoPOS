// server.js — RestoPOS LAN Sync (sin internet)
// npm i express cors lowdb nanoid

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const { nanoid } = require('nanoid');

// ===== DB (JSON en disco) =====
const db = new Low(new JSONFile('./restopos-db.json'), {
  products: [],     // {id, nombre, precio, stock, trackStock, categoria}
  mozos: [],        // {id, nombre, activo}
  orders: [],       // {id, mesa, tipo, estado, inicio, cierre, fecha, items[], total, descuento, totalCobrado, pagos[], pago?, mozo, workflow, boxId, cancelTs}
  cash: [],         // cajas (historial y abierto)
  config: { restaurantName:'Mi Restaurante', adminPin:'1234', tables:20 }
});

async function initDB(){
  await db.read();
  db.data ||= {};
  db.data.products ||= [];
  db.data.mozos ||= [];
  db.data.orders ||= [];
  db.data.cash ||= [];
  db.data.config ||= { restaurantName:'Mi Restaurante', adminPin:'1234', tables:20 };
  await db.write();
}
function money(n){ return Number.isFinite(n) ? n|0 : 0; }
function todayISO(){ return new Date().toISOString().slice(0,10); }

// ===== SSE (eventos en vivo) =====
let clients = [];
function broadcast(type, payload){
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(res => res.write(data));
}

// ===== App/HTTP =====
const app = express();
const http = createServer(app);
app.use(cors());
app.use(express.json({limit:'1mb'}));

// —— Eventos (SSE) ——
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive',
    'Access-Control-Allow-Origin':'*'
  });
  res.write(': connected\n\n');
  clients.push(res);
  req.on('close', () => { clients = clients.filter(r => r !== res); });
});

// —— Config ——
app.get('/api/config', async (req,res)=>{ await db.read(); res.json(db.data.config); });
app.put('/api/config', async (req,res)=>{ await db.read(); db.data.config = {...db.data.config, ...req.body}; await db.write(); res.json(db.data.config); });

// —— Productos ——
app.get('/api/products', async (req,res)=>{ await db.read(); res.json(db.data.products); });
app.post('/api/products', async (req,res)=>{ 
  await db.read(); 
  const p = req.body; if(!p.id) p.id = nanoid(6);
  const i = db.data.products.findIndex(x=>x.id===p.id);
  if(i>=0) db.data.products[i]=p; else db.data.products.push(p);
  await db.write(); res.json(p);
});
app.delete('/api/products/:id', async (req,res)=>{
  await db.read(); db.data.products = db.data.products.filter(p=>p.id!==req.params.id);
  await db.write(); res.json({ok:true});
});

// —— Mozos ——
app.get('/api/mozos', async (req,res)=>{ await db.read(); res.json(db.data.mozos); });
app.post('/api/mozos', async (req,res)=>{
  await db.read();
  const m = req.body; if(!m.id) m.id = nanoid(5);
  const i = db.data.mozos.findIndex(x=>x.id===m.id);
  if(i>=0) db.data.mozos[i]=m; else db.data.mozos.push(m);
  await db.write(); res.json(m);
});
app.delete('/api/mozos/:id', async (req,res)=>{
  await db.read(); db.data.mozos = db.data.mozos.filter(m=>m.id!==req.params.id);
  await db.write(); res.json({ok:true});
});

// —— Orders ——
app.get('/api/orders', async (req,res)=>{
  await db.read();
  const { estado, fecha } = req.query;
  let list = [...db.data.orders];
  if (estado) list = list.filter(o => o.estado === estado);
  if (fecha)  list = list.filter(o => o.fecha  === fecha);
  res.json(list);
});

app.post('/api/orders', async (req,res)=>{
  await db.read();
  const o = req.body;
  if (!o.id) o.id = nanoid(8);
  if (!o.inicio) o.inicio = new Date().toISOString();
  if (!o.fecha)  o.fecha  = todayISO();
  if (!o.estado) o.estado = 'abierto';
  o.total = o.items?.reduce((a,b)=>a + money(b.precio)*money(b.cant), 0) || 0;
  const i = db.data.orders.findIndex(x=>x.id===o.id);
  if (i>=0) db.data.orders[i] = o; else db.data.orders.push(o);
  await db.write();
  broadcast('order_updated', {id:o.id, estado:o.estado});
  res.json(o);
});

app.put('/api/orders/:id', async (req,res)=>{
  await db.read();
  const id = req.params.id;
  const cur = db.data.orders.find(o=>o.id===id);
  if (!cur) return res.status(404).json({error:'not found'});
  const upd = {...cur, ...req.body};
  upd.total = upd.items?.reduce((a,b)=>a + money(b.precio)*money(b.cant), 0) || 0;
  const i = db.data.orders.findIndex(o=>o.id===id);
  db.data.orders[i]=upd; await db.write();
  if (upd.workflow==='listo') broadcast('pedido_listo', {id, mesa:upd.mesa, mozo:upd.mozo, items:upd.items});
  broadcast('order_updated', {id, estado:upd.estado});
  res.json(upd);
});

// Cobrar pedido (actualiza caja + stock si track)
app.post('/api/orders/:id/charge', async (req,res)=>{
  await db.read();
  const id = req.params.id;
  const cur = db.data.orders.find(o=>o.id===id);
  if (!cur) return res.status(404).json({error:'not found'});

  const { pagos = [], descuento = 0 } = req.body;
  const total = cur.items.reduce((a,b)=>a + money(b.precio)*money(b.cant), 0);
  const neto  = Math.max(0, total - money(descuento));
  const sumaPagos = pagos.reduce((a,p)=> a + money(p.monto), 0);
  if (sumaPagos !== neto) return res.status(400).json({error:'Suma de pagos != total a cobrar'});

  // actualizar caja abierta
  const caja = db.data.cash.find(c=>!c.cierre);
  if (caja){
    caja.ventasByPay ||= {efectivo:0,tarjeta:0,transferencia:0,qr:0,otros:0};
    caja.ventasTotal = (caja.ventasTotal||0) + neto;
    pagos.forEach(p=>{
      const t = (p.tipo||'').toLowerCase();
      const key = t.includes('efectivo')?'efectivo': t.includes('tarjeta')?'tarjeta': t.includes('transfer')?'transferencia': (t.includes('qr')||t.includes('mp'))?'qr':'otros';
      caja.ventasByPay[key] = (caja.ventasByPay[key]||0) + money(p.monto);
    });
  }

  // actualizar stock
  cur.items.forEach(it=>{
    const prod = db.data.products.find(x=>x.id===it.id);
    if (prod && prod.trackStock) prod.stock = Math.max(0,(prod.stock||0)-it.cant);
  });

  // cerrar pedido
  Object.assign(cur, {
    descuento: money(descuento),
    total,
    totalCobrado: neto,
    pagos,
    estado: 'cerrado',
    cierre: new Date().toISOString(),
    boxId: caja?.id ?? null
  });

  await db.write();
  broadcast('order_closed', {id});
  res.json(cur);
});

// Anular (con rollback)
app.post('/api/orders/:id/cancel', async (req,res)=>{
  await db.read();
  const id = req.params.id;
  const cur = db.data.orders.find(o=>o.id===id);
  if (!cur) return res.status(404).json({error:'not found'});

  if (cur.estado === 'cerrado'){
    const caja = cur.boxId ? db.data.cash.find(c=>c.id===cur.boxId) : db.data.cash.find(c=>!c.cierre);
    if (caja){
      const totalCobrado = (cur.totalCobrado || cur.total || 0);
      caja.ventasTotal = Math.max(0, (caja.ventasTotal||0) - totalCobrado);
      const pagos = cur.pagos?.length ? cur.pagos : (cur.pago ? [{tipo:cur.pago.tipo, monto: totalCobrado}] : []);
      caja.ventasByPay ||= {efectivo:0,tarjeta:0,transferencia:0,qr:0,otros:0};
      pagos.forEach(p=>{
        const t=(p.tipo||'').toLowerCase();
        const key = t.includes('efectivo')?'efectivo': t.includes('tarjeta')?'tarjeta': t.includes('transfer')?'transferencia': (t.includes('qr')||t.includes('mp'))?'qr':'otros';
        caja.ventasByPay[key] = Math.max(0, (caja.ventasByPay[key]||0) - money(p.monto||0));
      });
    }
    // devolver stock
    cur.items.forEach(it=>{
      const prod = db.data.products.find(x=>x.id===it.id);
      if (prod && prod.trackStock) prod.stock = (prod.stock||0) + it.cant;
    });
  }

  cur.estado = 'anulado';
  cur.cancelTs = new Date().toISOString();
  await db.write();
  broadcast('order_cancelled', {id});
  res.json({ok:true});
});

// —— Caja ——
app.get('/api/cash/open', async (req,res)=>{ await db.read(); res.json(db.data.cash.find(c=>!c.cierre) || null); });
app.post('/api/cash/open', async (req,res)=>{
  await db.read();
  const { aperturaPesos=0, cajero='', turno='' } = req.body;
  const apertura = Math.round(parseFloat(String(aperturaPesos).replace(',','.'))*100)||0;
  const box = {
    id: nanoid(7),
    apertura, aperturaTs: new Date().toISOString(),
    cajero, turno,
    movs: [],
    ventasByPay:{efectivo:0,tarjeta:0,transferencia:0,qr:0,otros:0},
    ingresosByPay:{efectivo:0,tarjeta:0,transferencia:0,qr:0,otros:0},
    egresosByPay:{efectivo:0,tarjeta:0,transferencia:0,qr:0,otros:0},
    ventasTotal:0, ingresosTotal:0, egresosTotal:0
  };
  db.data.cash.push(box); await db.write(); res.json(box);
});
app.post('/api/cash/movement', async (req,res)=>{
  await db.read();
  const open = db.data.cash.find(c=>!c.cierre); if(!open) return res.status(400).json({error:'no open cash'});
  const { tipo, medio, desc, monto } = req.body;
  const mov = { ts: new Date().toISOString(), tipo, medio, desc, monto: money(monto) };
  open.movs.push(mov);
  const key = (medio||'').toLowerCase().includes('efectivo')?'efectivo':
              (medio||'').toLowerCase().includes('tarjeta')?'tarjeta':
              (medio||'').toLowerCase().includes('transfer')?'transferencia':
              (medio||'').toLowerCase().includes('qr')?'qr':'otros';
  if (tipo==='ingreso'){
    open.ingresosTotal += mov.monto;
    open.ingresosByPay[key] = (open.ingresosByPay[key]||0) + mov.monto;
  } else {
    open.egresosTotal += mov.monto;
    open.egresosByPay[key] = (open.egresosByPay[key]||0) + mov.monto;
  }
  await db.write(); res.json(mov);
});
app.post('/api/cash/close', async (req,res)=>{
  await db.read();
  const open = db.data.cash.find(c=>!c.cierre); if(!open) return res.status(400).json({error:'no open cash'});
  const conteo = money(req.body.conteo||0);
  const efEsperado = (open.apertura||0) + (open.ingresosByPay.efectivo||0) + (open.ventasByPay.efectivo||0) - (open.egresosByPay.efectivo||0);
  open.cierre = true;
  open.cierreTs = new Date().toISOString();
  open.conteo = conteo;
  open.efectivoEsperado = efEsperado;
  open.diferenciaEf = conteo - efEsperado;
  open.final = (open.apertura||0) + (open.ingresosTotal||0) + (open.ventasTotal||0) - (open.egresosTotal||0);
  await db.write(); res.json(open);
});
app.get('/api/cash/history', async (req,res)=>{
  await db.read();
  const { desde, hasta } = req.query;
  const list = db.data.cash.filter(c=>c.cierre).filter(c=>{
    const d = (c.aperturaTs||'').slice(0,10);
    return (!desde || d >= desde) && (!hasta || d <= hasta);
  });
  res.json(list);
});

// ====== Estáticos ======
const path = require('path');
const PUBLIC_DIR = __dirname; // mismos archivos que server.js

// Servir archivos estáticos (HTML, JS, CSS, imágenes, etc.)
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, f) => {
    if (f.endsWith('.html')) res.setHeader('Cache-Control','no-cache');
  }
}));

// Página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Rutas directas a otras vistas
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get(['/mozo', '/mozo.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mozo.html')));
app.get(['/cocina', '/cocina.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cocina.html')));

// ====== Start ======
const PORT = process.env.PORT || 10000; // Render asigna este puerto
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`✅ RestoPOS LAN listo en http://${HOST}:${PORT}`);
});
