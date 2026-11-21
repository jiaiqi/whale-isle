export function pickAmbient(manifest, rng = Math.random) {
    const pool = manifest.ambientPool.filter((c) => c.weight > 0);
    if (pool.length === 0) {
        // 池空兜底：回落 idle 首个 clip
        const idle = manifest.actions.find((a) => a.actionState === manifest.defaultAction) ?? manifest.actions[0];
        const clip = idle?.clips[0];
        return { clipId: clip?.clipId ?? 'idle', webmPath: clip?.webmPath ?? '', category: 'idle' };
    }
    const total = pool.reduce((s, c) => s + c.weight, 0);
    let roll = rng() * total;
    for (const c of pool) {
        roll -= c.weight;
        if (roll <= 0)
            return { clipId: c.clipId, webmPath: c.webmPath, category: c.category };
    }
    const last = pool[pool.length - 1];
    if (!last)
        return { clipId: 'idle', webmPath: '', category: 'idle' };
    return { clipId: last.clipId, webmPath: last.webmPath, category: last.category };
}
//# sourceMappingURL=ambient-pool.js.map