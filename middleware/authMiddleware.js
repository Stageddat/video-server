const { MASTER_PASSWORD, SPECIAL_PASSWORD } = require("../config");

function authMiddleware(req, res, next) {
  const providedPassword = req.headers.authorization;

  if (!providedPassword) {
    return res.status(401).json({
      success: false,
      error: "MISSING_PASSWORD",
      message: "password required",
    });
  }

  req.isSpecialPassword = providedPassword === SPECIAL_PASSWORD;

  if (!req.isSpecialPassword && providedPassword !== MASTER_PASSWORD) {
    return res.status(401).json({
      success: false,
      error: "WRONG_PASSWORD",
      message: "wrong password",
    });
  }

  next();
}

module.exports = authMiddleware;
