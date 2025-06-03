const MASTER_PASSWORD = process.env.MASTER_PASSWORD;
const SPECIAL_PASSWORD = process.env.SPECIAL_PASSWORD;

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: "MISSING_PASSWORD",
      message: "Authorization header is missing.",
    });
  }

  if (authHeader !== MASTER_PASSWORD) {
    if (authHeader === SPECIAL_PASSWORD) {
      req.isSpecialPassword = true;
      return next();
    } else {
      return res.status(401).json({
        success: false,
        error: "WRONG_PASSWORD",
        message: "Incorrect password.",
      });
    }
  }

  req.isSpecialPassword = false;
  next();
};

module.exports = authMiddleware;
