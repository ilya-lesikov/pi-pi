// Vitest global setup — runs before every test file loads.
// Keeps existing tests disk-pure by disabling the persistent map cache.
// New tests that exercise persistence opt back in per-test by clearing
// this env var and setting PI_HASHLINE_MAP_CACHE_DIR.
process.env.PI_HASHLINE_NO_PERSIST_MAPS = "1";
