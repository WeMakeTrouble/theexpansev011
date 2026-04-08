const PHOSPHOR_GREEN = '#00FF75';
const SCANLINE_OPACITY = 0.3;

export const createAsciiCanvas = (containerId, cols, rows, options = {}) => {
  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`Container #${containerId} not found`);
  }
  
  const {
    fontFamily = '"Courier New", Consolas, "SF Mono", monospace',
    fontSize = 16,
    backgroundColor = '#000000',
    phosphorColor = PHOSPHOR_GREEN,
    enableGlow = true,
    enableScanlines = true,
    dpr = window.devicePixelRatio ?? 1
  } = options;
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  const charWidth = fontSize * 0.6;
  const charHeight = fontSize;
  
  const pixelWidth = cols * charWidth;
  const pixelHeight = rows * charHeight;
  
  canvas.width = pixelWidth * dpr;
  canvas.height = pixelHeight * dpr;
  canvas.style.width = `${pixelWidth}px`;
  canvas.style.height = `${pixelHeight}px`;
  
  ctx.scale(dpr, dpr);
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'top';
  
  let scanlineCanvas = null;
  if (enableScanlines) {
    scanlineCanvas = document.createElement('canvas');
    scanlineCanvas.width = pixelWidth;
    scanlineCanvas.height = pixelHeight;
    const scanCtx = scanlineCanvas.getContext('2d');
    scanCtx.fillStyle = `rgba(0, 0, 0, ${SCANLINE_OPACITY})`;
    for (let y = 0; y < pixelHeight; y += charHeight * 2) {
      scanCtx.fillRect(0, y, pixelWidth, charHeight);
    }
  }
  
  const renderFrame = (asciiGrid, colors = null) => {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    
    if (enableGlow) {
      ctx.shadowColor = phosphorColor;
      ctx.shadowBlur = 4;
    } else {
      ctx.shadowBlur = 0;
    }
    
    for (let row = 0; row < asciiGrid.length && row < rows; row++) {
      const line = asciiGrid[row] ?? [];
      const rowColors = colors?.[row];
      let currentColor = phosphorColor;
      ctx.fillStyle = currentColor;
      
      for (let col = 0; col < line.length && col < cols; col++) {
        const char = line[col] ?? ' ';
        const color = rowColors?.[col] ?? phosphorColor;
        if (color !== currentColor) {
          ctx.fillStyle = color;
          currentColor = color;
        }
        ctx.fillText(char, col * charWidth, row * charHeight);
      }
    }
    
    ctx.shadowBlur = 0;
    
    if (enableScanlines && scanlineCanvas) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(scanlineCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
  };
  
  const clear = () => {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
  };
  
  return Object.freeze({
    renderFrame,
    clear,
    getCanvas: () => canvas,
    cols,
    rows,
    charWidth,
    charHeight
  });
};

export const createAnimationLoop = (renderFn, targetFps = 12, prngSeed = 12345) => {
  let animationId = null;
  let isRunning = false;
  let lastTime = 0;
  let accumulator = 0;
  let seed = prngSeed;
  
  const frameInterval = 1000 / targetFps;
  
  const prng = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  
  const loop = (currentTime) => {
    if (!isRunning) return;
    const delta = currentTime - lastTime;
    lastTime = currentTime;
    accumulator += delta;
    
    while (accumulator >= frameInterval) {
      renderFn(currentTime);
      accumulator -= frameInterval;
    }
    animationId = requestAnimationFrame(loop);
  };
  
  const start = () => {
    if (isRunning) return;
    isRunning = true;
    lastTime = performance.now();
    animationId = requestAnimationFrame(loop);
  };
  
  const stop = () => {
    isRunning = false;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  };
  
  return Object.freeze({ start, stop, setSeed: (s) => { seed = s; } });
};

console.log('[canvasRenderer] ASCII Animator canvas renderer loaded');
