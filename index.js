const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const db = require("./db");



const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Import routes
const salesRoutes = require("./routes/saleRoute");   

// Use routes
app.use("/api/sales", salesRoutes); 

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Server is running" });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: err.message
  });
});

// Start server
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

app.get("/api/debug", (req, res) => {
  res.json({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    name: process.env.DB_NAME,
    hasPassword: !!process.env.DB_PASSWORD,
  });
});

module.exports = app;