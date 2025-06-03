const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const router = express.Router();

router.get("/check-auth", authMiddleware, (req, res) => {
  res
    .status(200)
    .json({ success: true, message: "Authentication successful." });
});

module.exports = router;
