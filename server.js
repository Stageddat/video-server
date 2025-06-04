const cors = require("cors");
const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const config = require("./config/index.js");
const { clearTempDir } = require("./src/services/fileService.js");

dotenv.config();
const app = express();
const PORT = process.env.PORT || config.PORT;

const videoRoutes = require("./src/routes/videoRoutes.js");
const authRoutes = require("./src/routes/authRoutes.js");

// --- CORS ---
const allowedOrigins = [
  "http://localhost:7777",
  "http://localhost",
  "https://sumi.stageddat.dev",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log(`[CORS] Bloqueado origen: ${origin}`); // Log
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

app.use("/", authRoutes);
app.use("/", videoRoutes);

app.use((req, res) => {
  console.log(`[404] Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: "Route not found",
    path: req.path,
    method: req.method,
  });
});

app.use((err, req, res, next) => {
  console.error("Error:", err.message, err.stack);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  clearTempDir();
});
