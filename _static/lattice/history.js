
// Three.js loaded via importmap
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export class RollingBuffer {
    constructor(capacity, width, height) {
        this.capacity = capacity;
        this.width = width;
        this.height = height;
        this.size = width * height;
        this.frames = new Array(capacity).fill(null);
        this.head = 0;
        this.count = 0; // Number of frames currently in buffer
        this.totalTicks = 0; // Total frames processed (for absolute tick mapping)
    }

    push(statePtr, moduleMemory) {
        // Copy data from WebAssembly memory
        // statePtr is a pointer to i32 array.
        // We only care about -1, 0, 1. Int8Array is sufficient.

        // Create a view on the Wasm memory for the cells
        const wasmCells = new Int32Array(moduleMemory.buffer, statePtr, this.size);

        // Copy to our buffer (compress to Int8 to save space?)
        // Yes, Int8Array is sufficient for -1/1 values.
        const frame = new Int8Array(this.size);
        for (let i = 0; i < this.size; i++) {
            frame[i] = wasmCells[i];
        }

        this.frames[this.head] = frame;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) {
            this.count++;
        }
        this.totalTicks++;
    }

    // Get frame relative to current HEAD (0 = latest pushed, -1 = previous, etc.)
    getFrame(offset) {
        if (offset > 0 || offset <= -this.count) return null;

        // head points to *next* write position.
        // So latest frame is head - 1.
        let index = (this.head - 1 + offset);

        // Handle wrapping
        while (index < 0) index += this.capacity;
        index = index % this.capacity;

        return this.frames[index];
    }

    getTick(offset) {
        return this.totalTicks - 1 + offset;
    }
}

// Flood fill to find connected component
function getConnectedComponent(frame, startIdx, width, height) {
    const visited = new Set();
    const stack = [startIdx];
    const component = new Set();
    const targetVal = frame[startIdx];

    // Only track "alive" or "up" cells (+1) usually?
    // History.md says: "If the cell is +1 (alive/up), find its connected component"
    if (targetVal !== 1) return component; // Return empty if clicking on background

    component.add(startIdx);
    visited.add(startIdx);

    const checkNeighbor = (idx) => {
        if (!visited.has(idx) && frame[idx] === targetVal) {
            visited.add(idx);
            component.add(idx);
            stack.push(idx);
        }
    };

    while (stack.length > 0) {
        const idx = stack.pop();
        const x = idx % width;
        const y = Math.floor(idx / width);

        // Neighbors (von Neumann or Moore? Lib uses Moore usually. History.md example suggests 4 or 8)
        // Let's use 8-way (Moore) to match Simulation default

        const wrapX = (v) => (v + width) % width;
        const wrapY = (v) => (v + height) % height;

        // 8 Neighbors
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = wrapX(x + dx);
                const ny = wrapY(y + dy);
                const nIdx = ny * width + nx;
                checkNeighbor(nIdx);
            }
        }
    }
    return component;
}

// Find neighbors of a set of cells (boundary of the blob)
function getNeighborsOfSet(cellIndices, width, height) {
    const neighbors = new Set();
    const wrapX = (v) => (v + width) % width;
    const wrapY = (v) => (v + height) % height;

    for (const idx of cellIndices) {
        const x = idx % width;
        const y = Math.floor(idx / width);

        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = wrapX(x + dx);
                const ny = wrapY(y + dy);
                neighbors.add(ny * width + nx);
            }
        }
    }
    return neighbors;
}

export function traceBackward(buffer, currentBlob, width, height, maxFrames = 200) {
    const result = {
        frames: new Map(), // tick -> Set(indices)
        splits: [],
        merges: []
    };

    let activeBlob = new Set(currentBlob);

    // Start from offset 0 (current frame) back to -maxFrames
    for (let offset = 0; offset >= -maxFrames; offset--) {
        const frame = buffer.getFrame(offset);
        if (!frame) break;

        const tick = buffer.getTick(offset);

        // Rule: Ancestors are +1 AND (in activeBlob OR adjacent to activeBlob)
        // This allows tracking cells that 'moved' into the blob region

        // Optimization: Checking all cells is slow. 
        // Instead, check only cells in activeBlob and their neighbors?
        // Wait, logic: "A cell at frame N-1 is an ancestor if it's +1 AND (was in the blob at frame N OR is adjacent...)"
        // This implies we look at frame N-1 cells. Which ones?
        // The ones that *spatially overlap* with the blob at N, OR are adjacent to it.

        const candidateIndices = new Set([...activeBlob, ...getNeighborsOfSet(activeBlob, width, height)]);
        const ancestors = new Set();

        for (const idx of candidateIndices) {
            if (frame[idx] === 1) {
                ancestors.add(idx);
            }
        }

        if (ancestors.size === 0) {
            result.frames.set(tick, new Set()); // Dead
            break;
        }

        // Expand to full connected components
        // For each ancestor cell, find the full component it belongs to in frame N-1
        const fullAncestorBlob = new Set();
        const visited = new Set();

        for (const idx of ancestors) {
            if (!visited.has(idx)) {
                const component = getConnectedComponent(frame, idx, width, height);
                for (const c of component) {
                    fullAncestorBlob.add(c);
                    visited.add(c);
                }
            }
        }

        result.frames.set(tick, fullAncestorBlob);
        activeBlob = fullAncestorBlob;
    }

    return result;
}

export function traceForward(simulation, currentBlob, maxFrames, stopOnExpanded = 0.5) {
    const width = simulation.get_width();
    const height = simulation.get_height();
    const result = {
        frames: new Map()
    };

    // We need a cloned simulation to run forward without affecting main sim
    const simClone = simulation.copy();
    let topTick = 0; // Relative tick
    let activeBlob = new Set(currentBlob);

    for (let i = 1; i <= maxFrames; i++) {
        simClone.tick();
        const cellsPtr = simClone.get_cells_ptr();
        // Access memory directly
        // Note: tricky to get memory buffer if we don't have reference to 'memory' object here.
        // We might need memory passed in or access it via wasm instance if possible.
        // Provided 'simulation' is the binding class. 
        // We might need to assume we can read `simulation.memory` or passes it in.
        // Actually, `simulation.get_cells_ptr` returns a number. We need the WASM memory buffer.
        // We will assume `wasmMemory` is passed or available globally for now? 
        // Or we pass `moduleMemory` to this function.
        // Use Global `wasmMemory` for now, assuming index.html sets it.

        const cells = new Int32Array(window.wasmMemory.buffer, cellsPtr, width * height);

        const candidateIndices = new Set([...activeBlob, ...getNeighborsOfSet(activeBlob, width, height)]);
        const descendants = new Set();

        for (const idx of candidateIndices) {
            if (cells[idx] === 1) {
                descendants.add(idx);
            }
        }

        if (descendants.size === 0) break;

        const fullDescendantBlob = new Set();
        const visited = new Set();
        for (const idx of descendants) {
            if (!visited.has(idx)) {
                // Warning: getConnectedComponent expects simple array, Int32Array works too
                const component = getConnectedComponent(cells, idx, width, height);
                for (const c of component) {
                    fullDescendantBlob.add(c);
                    visited.add(c);
                }
            }
        }

        result.frames.set(i, fullDescendantBlob); // Relative tick +i
        activeBlob = fullDescendantBlob;

        if (activeBlob.size > width * height * stopOnExpanded) break;
    }

    return result;
}

// 3D Visualization
export function renderSpacetimeStructure(backwardTrace, forwardTrace, width, height, maxVoxels = 20000) {
    const group = new THREE.Group();

    // Helper to add voxel
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial();

    // We need to collect all valid positions and colors first
    // Then create an InstancedMesh

    const matrices = [];
    const colors = [];
    let voxelCount = 0;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    // Determine 'now' from the max tick in backward trace
    let maxTick = -1;
    for (const t of backwardTrace.frames.keys()) {
        if (t > maxTick) maxTick = t;
    }

    const processFrame = (cells, tickOffset, isPast) => {
        if (voxelCount >= maxVoxels) return;

        if (isPast) {
            // Blue (past) -> White (present)
            const t = 1.0 - (Math.abs(tickOffset) / 200);
            color.setHSL(0.6, 1.0, 0.2 + 0.8 * t);
        } else {
            // White (present) -> Red (future)
            const t = tickOffset / 200;
            color.setHSL(0.0, 1.0, 1.0 - 0.5 * t);
        }

        for (const idx of cells) {
            if (voxelCount >= maxVoxels) return;

            const x = idx % width;
            const y = Math.floor(idx / width);
            const z = tickOffset;

            dummy.position.set(x - width / 2, -y + height / 2, z);
            dummy.updateMatrix();

            matrices.push(dummy.matrix.clone());
            colors.push(color.clone());
            voxelCount++;
        }
    };

    // Backward (Past)
    for (const [tick, cells] of backwardTrace.frames) {
        if (voxelCount >= maxVoxels) break;
        const offset = tick - maxTick;
        processFrame(cells, offset, true);
    }

    // Forward (Future)
    for (const [relTick, cells] of forwardTrace.frames) {
        if (voxelCount >= maxVoxels) break;
        processFrame(cells, relTick, false);
    }

    if (voxelCount > 0) {
        const mesh = new THREE.InstancedMesh(geometry, material, voxelCount);

        for (let i = 0; i < voxelCount; i++) {
            mesh.setMatrixAt(i, matrices[i]);
            mesh.setColorAt(i, colors[i]);
        }

        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;

        group.add(mesh);
    }

    return group;
}

// Export function
export function exportToGLB(scene) {
    const exporter = new GLTFExporter();
    exporter.parse(
        scene,
        function (gltf) {
            const output = JSON.stringify(gltf, null, 2);
            const blob = new Blob([output], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.style.display = 'none';
            link.href = url;
            link.download = 'spacetime_structure.gltf'; // Standard GLTF JSON
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        },
        function (error) {
            console.error('An error happened during GLTF export', error);
        },
        {} // options
    );
}

// Helpers
export { getConnectedComponent };
