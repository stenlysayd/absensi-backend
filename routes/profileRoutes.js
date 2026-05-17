const express = require('express');
const multer = require('multer');

const {
  getProfile,
  updateProfile,
  changePassword,
} = require('../controllers/profileController');
const { verifyToken } = require('../middlewares/authMiddleware');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(verifyToken);

router.get('/', getProfile);
router.put('/', upload.single('photo'), updateProfile);
router.put('/password', changePassword);

module.exports = router;
