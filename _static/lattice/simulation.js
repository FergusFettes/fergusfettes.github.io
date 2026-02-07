
// embed/simulation.js

export class EmbedSimulation {
    constructor(canvas, wasmCallback, config) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.wasmCallback = wasmCallback; // Function that returns { sim, mem }
        this.config = config;
        this.sim = null;
        this.mem = null;
        this.animationId = null;
        this.lastTime = 0;
        this.fpsInterval = 1000 / (config.speed || 30);

        // Config defaults
        this.cellSize = config.density || 4;
        this.colorAlive = config.colorAlive || "#FFFFFF";
        this.colorDead = config.colorDead || "#050505";
    }

    async init() {
        const { sim, mem } = await this.wasmCallback();
        // Create a distinct simulation instance if the WASM supports it.
        // The WASM exports `Simulation` class. 
        // We assume `sim` passed here is the module exports or factory.

        // Wait, wasmCallback returns the module exports.
        // We need to instantiate `new Simulation()`.

        // Actually, let's assume wasmCallback returns { Simulation, memory }
        const SimulationClass = sim.Simulation;
        this.mem = mem; // WebAssembly.Memory

        if (!SimulationClass) {
            console.error("Simulation class not found in WASM exports");
            return;
        }

        this.sim = SimulationClass.new();

        this.resize();
        this.applyConfig();

        // Initial Draw
        this.draw();

        // Start if autoplay
        if (this.config.autoplay) {
            this.start();
        }
    }

    resize(width, height) {
        if (!width) {
            width = this.canvas.clientWidth;
            height = this.canvas.clientHeight;
        }
        this.canvas.width = width;
        this.canvas.height = height;

        // Calculate lattice dims
        const latW = Math.floor(width / this.cellSize);
        const latH = Math.floor(height / this.cellSize);

        if (this.sim) {
            // Check if resolution change needed
            if (this.sim.get_width() !== latW || this.sim.get_height() !== latH) {
                this.sim.set_resolution(latW, latH);
                // Re-init state if resized? Usually set_resolution might clear or preserve.
                // Re-apply config init might be needed.
                if (this.config.init?.type === 'random') {
                    this.sim.init_random(this.config.init.density || 0.5);
                }
            }
        }
    }

    applyConfig() {
        if (!this.sim) return;
        const c = this.config;

        // Presets
        if (c.preset === 'ising') {
            this.sim.set_ising_params(2.27, 0.0, 1.0, "metropolis");
            this.sim.set_update_config(false, true, "async_first", 1.0);
        } else if (c.preset === 'ising-cold') {
            this.sim.set_ising_params(1.0, 0.0, 1.0, "metropolis");
            this.sim.set_update_config(false, true, "async_first", 1.0);
        } else if (c.preset === 'ising-hot') {
            this.sim.set_ising_params(4.0, 0.0, 1.0, "metropolis");
            this.sim.set_update_config(false, true, "async_first", 1.0);
        } else if (c.preset === 'gol') {
            // GoL standard
            this.sim.set_gol_rules(
                (1 << 3), // Birth 3
                (1 << 2) | (1 << 3) // Survival 2,3
            );
            this.sim.set_update_config(true, false, "async_first", 0.0);
        }

        // Overrides
        if (c.async) {
            if (c.async.temperature !== undefined) {
                // Need current vals? No getters exposed easily. Assume set_ising_params overwrites all.
                // We should probably store state in JS or use defaults.
                const t = c.async.temperature || 2.27;
                const h = c.async.field || 0.0;
                const j = c.async.coupling || 1.0;
                const dyn = c.async.dynamics || "metropolis";
                this.sim.set_ising_params(t, h, j, dyn);
            }
            if (c.async.enabled !== undefined) {
                // Update config requires all 4 args.
                // This is tricky without getters. 
                // We'll rely on correct full config or preset first.
            }
        }

        // GoL Rules
        if (c.sync) {
            let birth = 0;
            if (c.sync.birth) c.sync.birth.forEach(b => birth |= (1 << b));
            let survival = 0;
            if (c.sync.survival) c.sync.survival.forEach(s => survival |= (1 << s));

            if (birth > 0 || survival > 0) {
                this.sim.set_gol_rules(birth, survival);
            }
        }

        // --- GENERIC UPDATE CONFIG ---
        const hasPreset = !!c.preset;
        const hasOverrides = (c.sync && c.sync.enabled !== undefined) || (c.async && c.async.enabled !== undefined);

        if (!hasPreset || hasOverrides) {
            let syncEnabled = false;
            let asyncEnabled = true;

            // If preset active, default to its known values (approximate)
            if (c.preset === 'gol') {
                syncEnabled = true;
                asyncEnabled = false;
            }

            // Apply Overrides
            if (c.sync && c.sync.enabled !== undefined) syncEnabled = c.sync.enabled;
            if (c.async && c.async.enabled !== undefined) asyncEnabled = c.async.enabled;

            let order = c.updateOrder || "async_first";
            let asyncRate = 1.0;

            this.sim.set_update_config(syncEnabled, asyncEnabled, order, asyncRate);
        }

        // Boundaries
        if (c.boundaries) {
            const mapB = (s) => {
                if (s === 'fixed') return 1;
                if (s === 'reflect') return 2;
                if (s === 'absorbing') return 3;
                return 0; // periodic
            };
            const val = c.boundaries.fixedValue || 1;
            this.sim.set_boundaries(
                mapB(c.boundaries.top),
                mapB(c.boundaries.bottom),
                mapB(c.boundaries.left),
                mapB(c.boundaries.right),
                val
            );
        }

        // Init
        // If config has specific init settings
        if (c.init) {
            if (c.init.type === 'random') {
                this.sim.init_random(c.init.density || 0.5);
            } else if (c.init.type === 'empty') {
                // init_random(0.0) or clear?
                this.sim.clear(); // Assume clear exists based on lib.rs usually having it
            }
        } else if (!c.preset && !c.init) {
            // Default random
            this.sim.init_random(0.5);
        }
    }

    start() {
        if (!this.animationId) {
            this.lastTime = performance.now();
            this.loop();
        }
    }

    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    loop(timestamp) {
        this.animationId = requestAnimationFrame(this.loop.bind(this));

        const now = timestamp || performance.now();
        const elapsed = now - this.lastTime;

        if (elapsed > this.fpsInterval) {
            this.lastTime = now - (elapsed % this.fpsInterval);

            if (this.sim) {
                this.sim.tick();
                this.draw();
            }
        }
    }

    draw() {
        if (!this.sim) return;

        const width = this.sim.get_width();
        const height = this.sim.get_height();
        const size = this.cellSize;

        // Fill background
        this.ctx.fillStyle = this.colorDead;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        const ptr = this.sim.get_cells_ptr();
        const cells = new Int32Array(this.mem.buffer, ptr, width * height);

        this.ctx.fillStyle = this.colorAlive;
        this.ctx.beginPath();

        // Optimize: Draw rects is faster than individual? 
        // Or Path? Path with many rects is okay.

        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === 1) {
                const x = i % width;
                const y = Math.floor(i / width);
                this.ctx.fillRect(x * size, y * size, size, size);
            }
        }
    }
}
