import express from 'express';
import multer from 'multer';
import { asciiConverter } from '../services/asciiConverter/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('asciiRoutes');
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

router.post('/convert', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    
    const options = {
      resolutionMode: req.body.resolutionMode || 'highDetail',
      charSetMode: req.body.charSetMode || 'extendedDensity',
      edgeMode: req.body.edgeMode || 'hybrid',
      ditherMode: req.body.ditherMode || 'bayer',
      useUnicode: req.body.useUnicode !== 'false',
      structureStrength: parseFloat(req.body.structureStrength || '0.7')
    };
    
    logger.info('Converting image: %s (%d bytes) with options: %j',
      req.file.originalname,
      req.file.size,
      options
    );
    
    const startTime = Date.now();
    const result = await asciiConverter.convert(req.file.buffer, options);
    const duration = Date.now() - startTime;
    
    res.json({
      asciiData: result.asciiData,
      widthChars: result.widthChars,
      heightChars: result.heightChars,
      metadata: {
        ...result.metadata,
        durationMs: duration
      }
    });
    
  } catch (err) {
    logger.error('Conversion failed: %s', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
