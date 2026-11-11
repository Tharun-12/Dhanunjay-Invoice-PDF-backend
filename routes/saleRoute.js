const express = require("express");
const { randomUUID } = require("crypto");
const db = require("../db");

const router = express.Router();

const METHODS = ["Cash", "UPI", "Card", "Other"];
const STATUSES = ["Paid", "Partial", "Unpaid"];

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// mysql2 returns DECIMAL as strings and DATE as JS Date objects by default
// (your db.js doesn't change that), so normalise rows before sending them.
const toDateString = (d) => {
  if (!(d instanceof Date)) return d;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

const formatSale = (s) => ({
  ...s,
  subtotal: Number(s.subtotal),
  discount: Number(s.discount),
  total: Number(s.total),
  amount_paid: Number(s.amount_paid),
  sale_date: toDateString(s.sale_date),
});

const formatItem = (i) => ({
  ...i,
  quantity: Number(i.quantity),
  price: Number(i.price),
  line_total: Number(i.line_total),
});

const todayLocal = () => toDateString(new Date());

// Validates the form and recalculates all money values on the server
function parseForm(b) {
  const name = (b.customer_name || "").trim();
  const phone = (b.customer_phone || "").trim();
  if (!name) throw badRequest("Please enter the customer name.");
  if (!phone) throw badRequest("Please enter the customer WhatsApp number.");
  if (!METHODS.includes(b.payment_method)) throw badRequest("Invalid payment method.");
  if (!STATUSES.includes(b.payment_status)) throw badRequest("Invalid payment status.");

  const items = [];
  let subtotal = 0;
  for (const it of b.items || []) {
    const qty = parseInt(it.quantity || "1", 10);
    const price = parseFloat(it.price || "0");
    const sareeName = (it.saree_name || "").trim();
    if (!sareeName || !(qty > 0) || !(price > 0)) continue;
    const line = Math.round(qty * price * 100) / 100;
    subtotal += line;
    items.push({
      saree_name: sareeName,
      saree_code: (it.saree_code || "").trim() || null,
      quantity: qty,
      price,
      line_total: line,
    });
  }
  if (items.length === 0) {
    throw badRequest("Please add at least one saree with a name, quantity and price.");
  }

  const discount = Math.max(0, parseFloat(b.discount || "0") || 0);
  const total = Math.max(0, subtotal - discount);
  let paid = parseFloat(b.amount_paid || "0") || 0;
  if (b.payment_status === "Paid") paid = total;
  else if (b.payment_status === "Unpaid") paid = 0;
  else paid = Math.min(Math.max(paid, 0), total);

  return {
    sale: {
      customer_name: name,
      customer_phone: phone,
      customer_address: (b.customer_address || "").trim() || null,
      subtotal,
      discount,
      total,
      payment_method: b.payment_method,
      payment_status: b.payment_status,
      amount_paid: paid,
      notes: (b.notes || "").trim() || null,
      sale_date: /^\d{4}-\d{2}-\d{2}$/.test(b.sale_date) ? b.sale_date : todayLocal(),
    },
    items,
  };
}

// Next invoice number, e.g. INV-2026-001. Runs inside the transaction.
async function nextInvoiceNumber(conn) {
  const prefix = `INV-${new Date().getFullYear()}-`;
  const [rows] = await conn.query(
    "SELECT invoice_number FROM sales WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1 FOR UPDATE",
    [`${prefix}%`]
  );
  let next = 1;
  if (rows.length) {
    const m = rows[0].invoice_number.match(/(\d+)$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(3, "0")}`;
}

async function fetchSaleWithItems(conn, id) {
  const [[sale]] = await conn.query("SELECT * FROM sales WHERE id = ?", [id]);
  const [items] = await conn.query("SELECT * FROM sale_items WHERE sale_id = ?", [id]);
  return { ...formatSale(sale), sale_items: items.map(formatItem) };
}

// GET /api/sales -> all sales with their items, newest first
router.get("/", async (req, res, next) => {
  try {
    const [sales] = await db.query("SELECT * FROM sales ORDER BY created_at DESC, id");
    if (sales.length === 0) return res.json([]);

    const [items] = await db.query("SELECT * FROM sale_items WHERE sale_id IN (?)", [
      sales.map((s) => s.id),
    ]);
    const bySale = {};
    for (const it of items) (bySale[it.sale_id] ||= []).push(formatItem(it));

    res.json(sales.map((s) => ({ ...formatSale(s), sale_items: bySale[s.id] || [] })));
  } catch (err) {
    next(err);
  }
});

// POST /api/sales -> create sale + items in one transaction
router.post("/", async (req, res, next) => {
  let parsed;
  try {
    parsed = parseForm(req.body);
  } catch (err) {
    return next(err);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const id = randomUUID();
      const invoice_number = await nextInvoiceNumber(conn);

      await conn.query("INSERT INTO sales SET ?", [{ id, invoice_number, ...parsed.sale }]);
      await conn.query(
        "INSERT INTO sale_items (id, sale_id, saree_name, saree_code, quantity, price, line_total) VALUES ?",
        [parsed.items.map((i) => [randomUUID(), id, i.saree_name, i.saree_code, i.quantity, i.price, i.line_total])]
      );

      await conn.commit();
      const saved = await fetchSaleWithItems(conn, id);
      return res.status(201).json(saved);
    } catch (err) {
      await conn.rollback();
      if (err.code === "ER_DUP_ENTRY" && attempt < 2) continue; // invoice number clash, retry
      return next(err);
    } finally {
      conn.release();
    }
  }
});

// DELETE /api/sales/:id -> items are removed by ON DELETE CASCADE
router.delete("/:id", async (req, res, next) => {
  try {
    const [result] = await db.query("DELETE FROM sales WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Sale not found." });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;