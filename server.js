require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dbPath = process.env.DB_PATH || path.join(__dirname, "grainora.db");
const db = new DatabaseSync(dbPath);
// Compatibility helpers: use Node.js built-in SQLite so no C++ build tools are needed.
db.pragma = (statement) => db.exec(`PRAGMA ${statement}`);
db.transaction = (callback) => (...args) => {
  db.exec("BEGIN");
  try {
    const result = callback(...args);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw error;
  }
};
db.pragma("journal_mode = WAL");
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

db.exec(`
CREATE TABLE IF NOT EXISTS farmers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 farmer_code TEXT UNIQUE,
 name TEXT NOT NULL,
 phone TEXT NOT NULL,
 address TEXT DEFAULT '',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchases (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 receipt_no TEXT UNIQUE,
 farmer_id INTEGER,
 quantity_kg REAL NOT NULL CHECK(quantity_kg > 0),
 price_per_kg REAL NOT NULL CHECK(price_per_kg >= 0),
 quality TEXT DEFAULT 'Standard',
 purchase_date TEXT NOT NULL,
 payment_status TEXT DEFAULT 'Pending',
 notes TEXT DEFAULT '',
 FOREIGN KEY(farmer_id) REFERENCES farmers(id)
);
CREATE TABLE IF NOT EXISTS inventory (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 item_name TEXT NOT NULL UNIQUE,
 category TEXT NOT NULL,
 quantity_kg REAL NOT NULL DEFAULT 0 CHECK(quantity_kg >= 0),
 reorder_level REAL NOT NULL DEFAULT 100,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS production (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 batch_no TEXT UNIQUE,
 production_date TEXT NOT NULL,
 paddy_processed_kg REAL NOT NULL CHECK(paddy_processed_kg > 0),
 rice_output_kg REAL NOT NULL CHECK(rice_output_kg >= 0),
 bran_kg REAL NOT NULL DEFAULT 0,
 husk_kg REAL NOT NULL DEFAULT 0,
 wastage_kg REAL NOT NULL DEFAULT 0,
 rice_variety TEXT DEFAULT 'Ponni Rice',
 notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_code TEXT UNIQUE,
 name TEXT NOT NULL,
 phone TEXT DEFAULT '',
 address TEXT DEFAULT '',
 customer_type TEXT DEFAULT 'Retailer',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sales (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 invoice_no TEXT UNIQUE,
 customer_id INTEGER,
 rice_variety TEXT NOT NULL,
 quantity_kg REAL NOT NULL CHECK(quantity_kg > 0),
 price_per_kg REAL NOT NULL CHECK(price_per_kg >= 0),
 amount_paid REAL NOT NULL DEFAULT 0 CHECK(amount_paid >= 0),
 sale_date TEXT NOT NULL,
 notes TEXT DEFAULT '',
 FOREIGN KEY(customer_id) REFERENCES customers(id)
);
CREATE TABLE IF NOT EXISTS expenses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 expense_date TEXT NOT NULL,
 category TEXT NOT NULL,
 description TEXT DEFAULT '',
 amount REAL NOT NULL CHECK(amount >= 0)
);
CREATE TABLE IF NOT EXISTS stock_movements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 movement_date TEXT DEFAULT CURRENT_TIMESTAMP,
 item_name TEXT NOT NULL,
 movement_type TEXT NOT NULL,
 quantity_kg REAL NOT NULL,
 reference TEXT DEFAULT '',
 notes TEXT DEFAULT ''
);
`);
const seedStock = db.prepare("INSERT OR IGNORE INTO inventory(item_name,category,quantity_kg,reorder_level) VALUES(?,?,?,?)");
seedStock.run("Raw Paddy", "Raw material", 0, 1000);
seedStock.run("Ponni Rice", "Finished rice", 0, 500);
seedStock.run("Rice Bran", "By-product", 0, 100);
seedStock.run("Rice Husk", "By-product", 0, 100);

const wrap = fn => (req,res,next) => { try { fn(req,res,next); } catch (e) { if (String(e.message).includes("UNIQUE constraint failed")) return res.status(409).json({error:"That code or name already exists."}); if (e.message.includes("CHECK constraint failed")) return res.status(400).json({error:"Please check quantities and amounts; they must be valid non-negative values."}); next(e); } };
const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
function requiredText(value, label) { if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${label} is required.`), {status:400}); return value.trim(); }
function positive(value, label, allowZero=false) { const n=Number(value); if (!Number.isFinite(n) || (allowZero ? n<0 : n<=0)) throw Object.assign(new Error(`${label} must be ${allowZero?"zero or greater":"greater than zero"}.`), {status:400}); return n; }
function dateValue(value,label) { const s=requiredText(value,label); if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Object.assign(new Error(`${label} must use YYYY-MM-DD format.`),{status:400}); return s; }
function stockDelta(name, category, delta, reference) {
 let item=get("SELECT * FROM inventory WHERE item_name=?",name);
 if(!item){run("INSERT INTO inventory(item_name,category,quantity_kg,reorder_level) VALUES(?,?,0,100)",name,category);item=get("SELECT * FROM inventory WHERE item_name=?",name);}
 const next=Number(item.quantity_kg)+Number(delta);
 if(next < -0.0001) throw Object.assign(new Error(`Not enough ${name} in stock. Available: ${item.quantity_kg} kg.`),{status:400});
 run("UPDATE inventory SET quantity_kg=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",Math.max(0,next),item.id);
 run("INSERT INTO stock_movements(item_name,movement_type,quantity_kg,reference) VALUES(?,?,?,?)",name,delta>=0?"IN":"OUT",Math.abs(delta),reference||"");
}
function listRoute(table, order="id DESC") {
 app.get(`/api/${table}`, wrap((req,res)=>res.json(all(`SELECT * FROM ${table} ORDER BY ${order}`))));
}
app.get("/api/health", (req,res)=>res.json({ok:true,app:"Grainora API",time:new Date().toISOString()}));

app.get("/api/dashboard", wrap((req,res)=>{
 const scalar = sql => Number(get(sql).v||0);
 res.json({
  paddyStockKg: Number(get("SELECT quantity_kg v FROM inventory WHERE item_name='Raw Paddy'")?.v||0),
  riceStockKg: Number(get("SELECT COALESCE(SUM(quantity_kg),0) v FROM inventory WHERE category='Finished rice'").v||0),
  totalRiceProducedKg: scalar("SELECT COALESCE(SUM(rice_output_kg),0) v FROM production"),
  totalSales: scalar("SELECT COALESCE(SUM(quantity_kg*price_per_kg),0) v FROM sales"),
  pendingPayments: scalar("SELECT COALESCE(SUM(MAX(quantity_kg*price_per_kg-amount_paid,0)),0) v FROM sales"),
  purchaseCount: scalar("SELECT COUNT(*) v FROM purchases"),
  productionBatches: scalar("SELECT COUNT(*) v FROM production"),
  lowStock: all("SELECT * FROM inventory WHERE quantity_kg<=reorder_level ORDER BY quantity_kg ASC")
 });
}));

app.get("/api/farmers", wrap((req,res)=>res.json(all("SELECT f.*, COALESCE(SUM(p.quantity_kg),0) AS total_paddy_kg, COUNT(p.id) AS purchase_count FROM farmers f LEFT JOIN purchases p ON p.farmer_id=f.id GROUP BY f.id ORDER BY f.id DESC"))));
app.post("/api/farmers", wrap((req,res)=>{
 const name=requiredText(req.body.name,"Farmer name"), phone=requiredText(req.body.phone,"Contact number");
 const code=(req.body.farmer_code||`F-${Date.now()}`).trim();
 const info=run("INSERT INTO farmers(farmer_code,name,phone,address) VALUES(?,?,?,?)",code,name,phone,req.body.address||"");
 res.status(201).json(get("SELECT * FROM farmers WHERE id=?",info.lastInsertRowid));
}));
app.put("/api/farmers/:id", wrap((req,res)=>{
 const old=get("SELECT * FROM farmers WHERE id=?",Number(req.params.id)); if(!old)return res.status(404).json({error:"Farmer not found"});
 run("UPDATE farmers SET name=?,phone=?,address=? WHERE id=?",requiredText(req.body.name,"Farmer name"),requiredText(req.body.phone,"Contact number"),req.body.address||"",old.id);
 res.json(get("SELECT * FROM farmers WHERE id=?",old.id));
}));
app.delete("/api/farmers/:id", wrap((req,res)=>{
 if(get("SELECT id FROM purchases WHERE farmer_id=?",Number(req.params.id)))return res.status(409).json({error:"Farmer has purchase history and cannot be deleted."});
 res.json({deleted:run("DELETE FROM farmers WHERE id=?",Number(req.params.id)).changes>0});
}));
listRoute("purchases");
app.post("/api/purchases", wrap((req,res)=>{
 const farmerId=Number(req.body.farmer_id); if(!get("SELECT id FROM farmers WHERE id=?",farmerId))throw Object.assign(new Error("Select a valid farmer."),{status:400});
 const qty=positive(req.body.quantity_kg,"Quantity"), rate=positive(req.body.price_per_kg,"Price",true);
 const receipt=requiredText(req.body.receipt_no||`PUR-${Date.now()}`,"Receipt number");
 const date=dateValue(req.body.purchase_date,"Purchase date");
 const tx=db.transaction(()=>{
  const r=run("INSERT INTO purchases(receipt_no,farmer_id,quantity_kg,price_per_kg,quality,purchase_date,payment_status,notes) VALUES(?,?,?,?,?,?,?,?)",receipt,farmerId,qty,rate,req.body.quality||"Standard",date,req.body.payment_status||"Pending",req.body.notes||"");
  stockDelta("Raw Paddy","Raw material",qty,receipt); return r.lastInsertRowid;
 });
 const id=tx();res.status(201).json(get("SELECT p.*,f.name farmer_name FROM purchases p LEFT JOIN farmers f ON f.id=p.farmer_id WHERE p.id=?",id));
}));
app.put("/api/purchases/:id", wrap((req,res)=>{
 const old=get("SELECT * FROM purchases WHERE id=?",Number(req.params.id));if(!old)return res.status(404).json({error:"Purchase not found"});
 const qty=positive(req.body.quantity_kg,"Quantity"),rate=positive(req.body.price_per_kg,"Price",true),farmer=Number(req.body.farmer_id);
 if(!get("SELECT id FROM farmers WHERE id=?",farmer))throw Object.assign(new Error("Select a valid farmer."),{status:400});
 const tx=db.transaction(()=>{stockDelta("Raw Paddy","Raw material",qty-old.quantity_kg,old.receipt_no);run("UPDATE purchases SET farmer_id=?,quantity_kg=?,price_per_kg=?,quality=?,purchase_date=?,payment_status=?,notes=? WHERE id=?",farmer,qty,rate,req.body.quality||old.quality,dateValue(req.body.purchase_date,"Purchase date"),req.body.payment_status||old.payment_status,req.body.notes||"",old.id);});
 tx();res.json(get("SELECT p.*,f.name farmer_name FROM purchases p LEFT JOIN farmers f ON f.id=p.farmer_id WHERE p.id=?",old.id));
}));
app.delete("/api/purchases/:id", wrap((req,res)=>{
 const old=get("SELECT * FROM purchases WHERE id=?",Number(req.params.id));if(!old)return res.status(404).json({error:"Purchase not found"});
 const tx=db.transaction(()=>{stockDelta("Raw Paddy","Raw material",-old.quantity_kg,old.receipt_no);run("DELETE FROM purchases WHERE id=?",old.id)});tx();res.json({deleted:true});
}));

listRoute("inventory","item_name ASC");
app.post("/api/inventory", wrap((req,res)=>{
 const name=requiredText(req.body.item_name,"Item name"),category=requiredText(req.body.category,"Category"),qty=positive(req.body.quantity_kg??0,"Quantity",true),reorder=positive(req.body.reorder_level??100,"Reorder level",true);
 const r=run("INSERT INTO inventory(item_name,category,quantity_kg,reorder_level) VALUES(?,?,?,?)",name,category,qty,reorder);
 res.status(201).json(get("SELECT * FROM inventory WHERE id=?",r.lastInsertRowid));
}));
app.put("/api/inventory/:id", wrap((req,res)=>{
 const old=get("SELECT * FROM inventory WHERE id=?",Number(req.params.id));if(!old)return res.status(404).json({error:"Stock item not found"});
 const qty=positive(req.body.quantity_kg,"Quantity",true),reorder=positive(req.body.reorder_level,"Reorder level",true);
 run("UPDATE inventory SET category=?,quantity_kg=?,reorder_level=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",req.body.category||old.category,qty,reorder,old.id);
 res.json(get("SELECT * FROM inventory WHERE id=?",old.id));
}));
app.post("/api/inventory/adjust", wrap((req,res)=>{
 const name=requiredText(req.body.item_name,"Item name"),delta=Number(req.body.delta_kg);
 if(!Number.isFinite(delta)||delta===0)throw Object.assign(new Error("Stock adjustment must be a non-zero number."),{status:400});
 stockDelta(name,req.body.category||"Finished rice",delta,req.body.reference||"Manual adjustment");
 res.json(get("SELECT * FROM inventory WHERE item_name=?",name));
}));

listRoute("production");
app.post("/api/production", wrap((req,res)=>{
 const batch=requiredText(req.body.batch_no||`BATCH-${Date.now()}`,"Batch number"),date=dateValue(req.body.production_date,"Production date");
 const paddy=positive(req.body.paddy_processed_kg,"Paddy processed"),rice=positive(req.body.rice_output_kg,"Rice output",true);
 const bran=positive(req.body.bran_kg??0,"Bran",true),husk=positive(req.body.husk_kg??0,"Husk",true),wastage=positive(req.body.wastage_kg??0,"Wastage",true);
 if(rice+bran+husk+wastage>paddy*1.05)throw Object.assign(new Error("Total output looks higher than paddy input. Check the quantities."),{status:400});
 const variety=req.body.rice_variety||"Ponni Rice";
 const tx=db.transaction(()=>{const r=run("INSERT INTO production(batch_no,production_date,paddy_processed_kg,rice_output_kg,bran_kg,husk_kg,wastage_kg,rice_variety,notes) VALUES(?,?,?,?,?,?,?,?,?)",batch,date,paddy,rice,bran,husk,wastage,variety,req.body.notes||"");stockDelta("Raw Paddy","Raw material",-paddy,batch);stockDelta(variety,"Finished rice",rice,batch);stockDelta("Rice Bran","By-product",bran,batch);stockDelta("Rice Husk","By-product",husk,batch);return r.lastInsertRowid;});
 const id=tx();res.status(201).json(get("SELECT * FROM production WHERE id=?",id));
}));
app.delete("/api/production/:id", wrap((req,res)=>{
 const old=get("SELECT * FROM production WHERE id=?",Number(req.params.id));if(!old)return res.status(404).json({error:"Batch not found"});
 const tx=db.transaction(()=>{stockDelta("Raw Paddy","Raw material",old.paddy_processed_kg,old.batch_no);stockDelta(old.rice_variety,"Finished rice",-old.rice_output_kg,old.batch_no);stockDelta("Rice Bran","By-product",-old.bran_kg,old.batch_no);stockDelta("Rice Husk","By-product",-old.husk_kg,old.batch_no);run("DELETE FROM production WHERE id=?",old.id)});tx();res.json({deleted:true});
}));

app.get("/api/customers", wrap((req,res)=>res.json(all("SELECT c.*,COALESCE(SUM(s.quantity_kg*s.price_per_kg),0) total_sales FROM customers c LEFT JOIN sales s ON s.customer_id=c.id GROUP BY c.id ORDER BY c.id DESC"))));
app.post("/api/customers", wrap((req,res)=>{
 const code=(req.body.customer_code||`C-${Date.now()}`).trim();
 const r=run("INSERT INTO customers(customer_code,name,phone,address,customer_type) VALUES(?,?,?,?,?)",code,requiredText(req.body.name,"Customer name"),req.body.phone||"",req.body.address||"",req.body.customer_type||"Retailer");
 res.status(201).json(get("SELECT * FROM customers WHERE id=?",r.lastInsertRowid));
}));
app.put("/api/customers/:id", wrap((req,res)=>{
 const old=get("SELECT * FROM customers WHERE id=?",Number(req.params.id));if(!old)return res.status(404).json({error:"Customer not found"});
 run("UPDATE customers SET name=?,phone=?,address=?,customer_type=? WHERE id=?",requiredText(req.body.name,"Customer name"),req.body.phone||"",req.body.address||"",req.body.customer_type||"Retailer",old.id);
 res.json(get("SELECT * FROM customers WHERE id=?",old.id));
}));
app.delete("/api/customers/:id", wrap((req,res)=>{
 if(get("SELECT id FROM sales WHERE customer_id=?",Number(req.params.id)))return res.status(409).json({error:"Customer has sales history and cannot be deleted."});
 res.json({deleted:run("DELETE FROM customers WHERE id=?",Number(req.params.id)).changes>0});
}));
listRoute("sales");
app.post("/api/sales", wrap((req,res)=>{
 const customerId=req.body.customer_id?Number(req.body.customer_id):null;
 if(customerId&&!get("SELECT id FROM customers WHERE id=?",customerId))throw Object.assign(new Error("Select a valid customer."),{status:400});
 const variety=requiredText(req.body.rice_variety,"Rice variety"),qty=positive(req.body.quantity_kg,"Quantity"),rate=positive(req.body.price_per_kg,"Price",true),paid=positive(req.body.amount_paid??0,"Amount paid",true);
 const invoice=requiredText(req.body.invoice_no||`INV-${Date.now()}`,"Invoice number"),date=dateValue(req.body.sale_date,"Sale date");
 const tx=db.transaction(()=>{const r=run("INSERT INTO sales(invoice_no,customer_id,rice_variety,quantity_kg,price_per_kg,amount_paid,sale_date,notes) VALUES(?,?,?,?,?,?,?,?)",invoice,customerId,variety,qty,rate,paid,date,req.body.notes||"");stockDelta(variety,"Finished rice",-qty,invoice);return r.lastInsertRowid});
 const id=tx();res.status(201).json(get("SELECT s.*,c.name customer_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?",id));
}));
app.put("/api/sales/:id/payment", wrap((req,res)=>{
 const old=get("SELECT * FROM sales WHERE id=?",Number(req.params.id));if(!old)return res.status(404).json({error:"Invoice not found"});
 const paid=positive(req.body.amount_paid,"Amount paid",true);
 run("UPDATE sales SET amount_paid=? WHERE id=?",paid,old.id);
 res.json(get("SELECT s.*,c.name customer_name,(s.quantity_kg*s.price_per_kg-s.amount_paid) AS balance_due FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?",old.id));
}));
app.delete("/api/sales/:id", wrap((req,res)=>{
 const old=get("SELECT * FROM sales WHERE id=?",Number(req.params.id));if(!old)return res.status(404).json({error:"Invoice not found"});
 const tx=db.transaction(()=>{stockDelta(old.rice_variety,"Finished rice",old.quantity_kg,old.invoice_no);run("DELETE FROM sales WHERE id=?",old.id)});tx();res.json({deleted:true});
}));

app.get("/api/expenses", wrap((req,res)=>res.json(all("SELECT * FROM expenses ORDER BY expense_date DESC,id DESC"))));
app.post("/api/expenses", wrap((req,res)=>{
 const date=dateValue(req.body.expense_date,"Expense date"),category=requiredText(req.body.category,"Expense category"),amount=positive(req.body.amount,"Amount",true);
 const r=run("INSERT INTO expenses(expense_date,category,description,amount) VALUES(?,?,?,?)",date,category,req.body.description||"",amount);
 res.status(201).json(get("SELECT * FROM expenses WHERE id=?",r.lastInsertRowid));
}));
app.delete("/api/expenses/:id", wrap((req,res)=>res.json({deleted:run("DELETE FROM expenses WHERE id=?",Number(req.params.id)).changes>0})));
app.get("/api/reports/summary", wrap((req,res)=>{
 const month=String(req.query.month||new Date().toISOString().slice(0,7));
 res.json({
  month,
  monthlySales:Number(get("SELECT COALESCE(SUM(quantity_kg*price_per_kg),0) v FROM sales WHERE substr(sale_date,1,7)=?",month).v||0),
  monthlyExpenses:Number(get("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE substr(expense_date,1,7)=?",month).v||0),
  monthlyPaddyProcessed:Number(get("SELECT COALESCE(SUM(paddy_processed_kg),0) v FROM production WHERE substr(production_date,1,7)=?",month).v||0),
  monthlyRiceProduced:Number(get("SELECT COALESCE(SUM(rice_output_kg),0) v FROM production WHERE substr(production_date,1,7)=?",month).v||0),
  pendingPayments:Number(get("SELECT COALESCE(SUM(MAX(quantity_kg*price_per_kg-amount_paid,0)),0) v FROM sales").v||0),
  estimatedProfit:Number(get("SELECT COALESCE(SUM(quantity_kg*price_per_kg-amount_paid*0),0) v FROM sales WHERE substr(sale_date,1,7)=?",month).v||0)-Number(get("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE substr(expense_date,1,7)=?",month).v||0)
 });
}));
app.get("/api/stock-movements", wrap((req,res)=>res.json(all("SELECT * FROM stock_movements ORDER BY id DESC LIMIT 200"))));

app.use((err,req,res,next)=>{console.error(err);res.status(err.status||500).json({error:err.status?err.message:"Internal server error. Check the backend terminal for details."})});
app.listen(PORT,()=>console.log(`Grainora API running at http://localhost:${PORT}`));
