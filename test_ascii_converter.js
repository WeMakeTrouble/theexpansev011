import { asciiConverter } from './backend/services/asciiConverter/index.js';
import sharp from 'sharp';
import { createModuleLogger } from './backend/utils/logger.js';

const logger = createModuleLogger('test_ascii');

// Create a simple test image (gradient pattern)
const createTestImage = async () => {
  // 160x80 greyscale gradient - perfect for ASCII testing
  const width = 160;
  const height = 80;
  const data = Buffer.alloc(width * height);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Create gradient pattern: left dark, right light, with some vertical stripes
      const horizontal = (x / width) * 255;
      const vertical = Math.sin(y / 10) * 50;
      const stripe = (x % 20 < 10) ? 30 : -30;
      data[y * width + x] = Math.max(0, Math.min(255, horizontal + vertical + stripe));
    }
  }
  
  return sharp(data, {
    raw: { width, height, channels: 1 }
  }).png().toBuffer();
};

const runTest = async () => {
  try {
    logger.info('Creating test image...');
    const testImage = await createTestImage();
    logger.info('Test image created: %d bytes', testImage.length);
    
    logger.info('Testing standard conversion (80x40)...');
    const standardResult = await asciiConverter.convert(testImage, {
      resolutionMode: 'standard',
      charSetMode: 'standardAscii',
      ditherMode: 'bayer'
    });
    
    console.log('\n=== STANDARD ASCII OUTPUT ===');
    console.log(standardResult.asciiData);
    console.log('=== END OUTPUT ===\n');
    
    logger.info('Standard conversion: %dx%d (%d chars)',
      standardResult.widthChars,
      standardResult.heightChars,
      standardResult.asciiData.length
    );
    
    // Test edge detection mode
    logger.info('Testing edge detection mode...');
    const edgeResult = await asciiConverter.convert(testImage, {
      resolutionMode: 'standard',
      charSetMode: 'standardAscii',
      edgeMode: 'hybrid'
    });
    
    console.log('\n=== EDGE DETECTION OUTPUT ===');
    console.log(edgeResult.asciiData);
    console.log('=== END OUTPUT ===\n');
    
    logger.info('All tests passed');
    process.exit(0);
  } catch (err) {
    logger.error('Test failed: %s', err.message);
    console.error(err.stack);
    process.exit(1);
  }
};

runTest();
