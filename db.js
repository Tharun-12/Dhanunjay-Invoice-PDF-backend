const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "saree-billing",
  port: Number(process.env.DB_PORT) || 4306,
  ssl: process.env.DB_HOST ? { minVersion: "TLSv1.2", rejectUnauthorized: true } : undefined,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

module.exports = db;