
// embed/utils.js

/**
 * Merges defaults with user config
 */
export function mergeConfig(defaults, userConfig) {
    const result = { ...defaults };
    for (const key in userConfig) {
        if (typeof userConfig[key] === 'object' && userConfig[key] !== null && !Array.isArray(userConfig[key])) {
            result[key] = mergeConfig(result[key] || {}, userConfig[key]);
        } else {
            result[key] = userConfig[key];
        }
    }
    return result;
}

/**
 * Parse config from data attributes and inline JSON
 */
export function parseConfig(element) {
    const config = {};

    // 1. Data Attributes
    const dataset = element.dataset;
    if (dataset.preset) config.preset = dataset.preset;
    if (dataset.density) config.density = parseInt(dataset.density, 10);
    if (dataset.autoplay) config.autoplay = dataset.autoplay === 'true';
    if (dataset.speed) config.speed = parseInt(dataset.speed, 10);

    // 2. Inline JSON
    const script = element.querySelector('script[type="application/json"]');
    if (script) {
        try {
            const jsonConfig = JSON.parse(script.textContent);
            Object.assign(config, jsonConfig);
        } catch (e) {
            console.error("Invalid JSON config in lattice-embed:", e);
        }
    }

    // 3. Global Config (by ID)
    if (element.id && window.latticeConfigs && window.latticeConfigs[element.id]) {
        Object.assign(config, window.latticeConfigs[element.id]);
    }

    // Defaults
    if (config.autoplay === undefined) config.autoplay = true;
    if (config.density === undefined) config.density = 4;

    return config;
}

/**
 * Resolve WASM path based on script location
 */
export function getBaseUrl() {
    // If run as module
    if (import.meta.url) {
        return new URL('.', import.meta.url).href;
    }
    // Fallback if bundled (might need adjustment based on how it's bundled)
    return './';
}
