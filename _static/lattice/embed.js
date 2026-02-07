/**
 * Lattice Embed Script
 *
 * Finds all <div class="lattice-embed"> elements on the page, initialises the
 * WASM simulation once, then spins up an independent simulation + canvas inside
 * each container.
 *
 * Configuration per-embed (in priority order):
 *   1. Inline <script type="application/json"> child  (full config object)
 *   2. data-preset  attribute  ("ising-cold", "ising-hot", "gol")
 *   3. Individual data-* attributes (data-density, data-speed, etc.)
 *
 * The script auto-detects its own URL so it can resolve sibling assets
 * (the .js bindings and .wasm file) regardless of where the hosting page lives.
 */

// ---------------------------------------------------------------------------
// Resolve asset URLs relative to *this script*, not the hosting page.
// Supports both:
//   - trunk serve / trunk build (hashed filenames like lattice-gol-<hash>.js)
//   - make build (stable aliases lattice.js / lattice.wasm)
// ---------------------------------------------------------------------------
const SCRIPT_URL = new URL(import.meta.url);
const base = SCRIPT_URL.href.substring(0, SCRIPT_URL.href.lastIndexOf('/') + 1);

async function discoverAssets() {
  // 1. Look for Trunk-generated <link rel="modulepreload"> on this page
  const preload = document.querySelector('link[rel="modulepreload"][href*="lattice-gol"]');
  if (preload) {
    const jsHref = new URL(preload.getAttribute('href'), document.baseURI).href;
    return { bindingsUrl: jsHref, wasmUrl: jsHref.replace(/\.js$/, '_bg.wasm') };
  }

  // 2. Check if stable names exist (from make build)
  try {
    const resp = await fetch(base + 'lattice.js', { method: 'HEAD' });
    if (resp.ok && resp.headers.get('content-type')?.includes('javascript')) {
      return { bindingsUrl: base + 'lattice.js', wasmUrl: base + 'lattice.wasm' };
    }
  } catch (_) { /* not available */ }

  // 3. Fetch sibling index.html to extract the Trunk-hashed filename
  //    (handles demo.html served alongside index.html via trunk serve)
  try {
    const resp = await fetch(base + 'index.html');
    if (resp.ok) {
      const html = await resp.text();
      const match = html.match(/modulepreload[^>]+href="\.?\/?([^"]*lattice-gol[^"]*\.js)"/);
      if (match) {
        const jsHref = base + match[1];
        return { bindingsUrl: jsHref, wasmUrl: jsHref.replace(/\.js$/, '_bg.wasm') };
      }
    }
  } catch (_) { /* not available */ }

  // 4. Last resort
  return { bindingsUrl: base + 'lattice.js', wasmUrl: base + 'lattice.wasm' };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
const PRESETS = {
  'ising-cold': {
    async: { enabled: true, temperature: 1.0, field_h: 0, coupling_j: 1.0, sweeps: 1.0 },
    sync:  { enabled: false },
    init:  { type: 'random', density: 0.5 },
    speed: 30,
  },
  'ising-hot': {
    async: { enabled: true, temperature: 4.0, field_h: 0, coupling_j: 1.0, sweeps: 1.0 },
    sync:  { enabled: false },
    init:  { type: 'random', density: 0.5 },
    speed: 30,
  },
  'ising-critical': {
    async: { enabled: true, temperature: 2.27, field_h: 0, coupling_j: 1.0, sweeps: 1.0 },
    sync:  { enabled: false },
    init:  { type: 'random', density: 0.5 },
    speed: 30,
  },
  'gol': {
    async: { enabled: false },
    sync:  { enabled: true, birth: [3], survival: [2, 3] },
    init:  { type: 'random', density: 0.2 },
    speed: 10,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bitmask(arr) {
  let mask = 0;
  for (const n of arr) mask |= (1 << n);
  return mask;
}

function mergeDeep(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

/** Read the config for a single embed container. */
function readConfig(container) {
  // 1. Inline JSON
  const jsonScript = container.querySelector('script[type="application/json"]');
  let cfg = {};

  if (jsonScript) {
    try { cfg = JSON.parse(jsonScript.textContent); } catch (e) {
      console.warn('lattice-embed: bad inline JSON', e);
    }
  }

  // 2. Preset (can be overridden by inline JSON or data-* attrs)
  const presetName = container.dataset.preset;
  if (presetName && PRESETS[presetName]) {
    cfg = mergeDeep(structuredClone(PRESETS[presetName]), cfg);
  }

  // 3. Data attributes as overrides
  if (container.dataset.density) cfg.density = Number(container.dataset.density);
  if (container.dataset.speed)   cfg.speed   = Number(container.dataset.speed);

  // Defaults
  if (!cfg.density) cfg.density = 3;
  if (!cfg.speed)   cfg.speed   = 30;
  if (!cfg.async && !cfg.sync) {
    // Default to ising-critical if nothing specified
    Object.assign(cfg, structuredClone(PRESETS['ising-critical']));
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Per-embed instance
// ---------------------------------------------------------------------------

class LatticeEmbed {
  constructor(container, Simulation, wasmMemory, cfg) {
    this.container = container;
    this.cfg = cfg;
    this.wasmMemory = wasmMemory;

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.imageRendering = 'pixelated';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Sizing
    this.cellSize = cfg.density || 3;
    this.resize();

    // Simulation
    this.sim = Simulation.new();
    this.sim.set_resolution(this.gridW, this.gridH);
    this.applyCfg(cfg);

    // Offscreen buffer
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = this.gridW;
    this.offscreen.height = this.gridH;
    this.offCtx = this.offscreen.getContext('2d', { alpha: false });
    this.imgData = this.offCtx.createImageData(this.gridW, this.gridH);

    // Animation
    this.fpsInterval = 1000 / (cfg.speed || 30);
    this.lastTime = 0;
    this.running = true;
    this.animId = null;

    // Observe resize
    this.ro = new ResizeObserver(() => this.handleResize());
    this.ro.observe(container);

    // Start
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  applyCfg(cfg) {
    // Async / Ising
    const asyncEnabled = cfg.async?.enabled ?? false;
    const syncEnabled  = cfg.sync?.enabled  ?? false;
    const order = 'async_first';
    const sweeps = cfg.async?.sweeps ?? 1.0;
    this.sim.set_update_config(syncEnabled, asyncEnabled, order, sweeps);

    if (asyncEnabled) {
      const T = cfg.async.temperature ?? 2.27;
      const h = cfg.async.field_h ?? 0;
      const J = cfg.async.coupling_j ?? 1.0;
      this.sim.set_ising_params(T, h, J, 'metropolis');
    }

    // Sync / GoL
    if (syncEnabled && cfg.sync) {
      const birth    = bitmask(cfg.sync.birth    || [3]);
      const survival = bitmask(cfg.sync.survival || [2, 3]);
      this.sim.set_gol_rules(birth, survival);
    }

    // Init density
    if (cfg.init?.density !== undefined) {
      this.sim.init_random(cfg.init.density);
    }
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.floor(rect.width)  || 300;
    const h = Math.floor(rect.height) || 200;
    this.canvas.width  = w;
    this.canvas.height = h;
    this.gridW = Math.floor(w / this.cellSize);
    this.gridH = Math.floor(h / this.cellSize);
  }

  handleResize() {
    const oldW = this.gridW;
    const oldH = this.gridH;
    this.resize();
    if (this.gridW !== oldW || this.gridH !== oldH) {
      this.sim.set_resolution(this.gridW, this.gridH);
      this.offscreen.width  = this.gridW;
      this.offscreen.height = this.gridH;
      this.offCtx = this.offscreen.getContext('2d', { alpha: false });
      this.imgData = this.offCtx.createImageData(this.gridW, this.gridH);
    }
  }

  loop(timestamp) {
    this.animId = requestAnimationFrame(this.loop);
    const elapsed = timestamp - this.lastTime;
    if (elapsed < this.fpsInterval) return;
    this.lastTime = timestamp - (elapsed % this.fpsInterval);

    if (this.running) {
      this.sim.tick();
    }
    this.draw();
  }

  draw() {
    const w = this.gridW;
    const h = this.gridH;
    const ptr = this.sim.get_cells_ptr();
    const cells = new Int32Array(this.wasmMemory.buffer, ptr, w * h);
    const buf32 = new Uint32Array(this.imgData.data.buffer);

    const BG = 0xFF050505;
    const FG = 0xFFFFFFFF;

    for (let i = 0; i < w * h; i++) {
      buf32[i] = cells[i] === 1 ? FG : BG;
    }

    this.offCtx.putImageData(this.imgData, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.ro) this.ro.disconnect();
    this.sim.free();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function boot() {
  const containers = document.querySelectorAll('.lattice-embed');
  if (containers.length === 0) return;

  // Discover WASM asset URLs (works with both trunk serve and make build)
  const { bindingsUrl, wasmUrl } = await discoverAssets();

  // Dynamically import the bindings module
  const bindings = await import(bindingsUrl);
  const wasm = await bindings.default({ module_or_path: wasmUrl });

  // The wasm memory object lives on the instantiated module
  const wasmMemory = wasm.memory;

  for (const el of containers) {
    const cfg = readConfig(el);
    try {
      new LatticeEmbed(el, bindings.Simulation, wasmMemory, cfg);
    } catch (e) {
      console.error('lattice-embed: failed to init embed', el, e);
    }
  }
}

boot();
