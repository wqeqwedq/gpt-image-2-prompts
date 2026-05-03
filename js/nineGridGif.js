/**
 * 九宫格 GIF：整图缩限长边 → 中心正方形 → 3×3 → 每格向内各裁 3% 边长 → 9 帧行优先
 * GIF 编码依赖 gifenc（动态 import，需可访问 esm.sh 或换成本地拷贝）
 */

export const GIF_IMAGE_LONG_EDGE_MAX = 2048;
export const FRAME_DELAY_MIN = 40;
export const FRAME_DELAY_MAX = 2000;
export const FRAME_DELAY_DEFAULT = 150;
/** 相对单格边长，单侧舍弃比例 */
export const CELL_EDGE_TRIM = 0.03;

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

/**
 * @param {string} imageUrl
 * @returns {Promise<HTMLCanvasElement[]>} 9 张等大的 canvas，行优先
 */
export async function extractNineFrameCanvases(imageUrl) {
    const img = await loadImageCors(imageUrl);
    return rasterToNineFrames(img);
}

function loadImageCors(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败（可能无 CORS）'));
        img.src = url;
    });
}

/**
 * @param {HTMLImageElement} img
 * @returns {HTMLCanvasElement[]}
 */
export function rasterToNineFrames(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('无效图片尺寸');

    let tw = w;
    let th = h;
    const maxL = GIF_IMAGE_LONG_EDGE_MAX;
    if (Math.max(w, h) > maxL) {
        const s = maxL / Math.max(w, h);
        tw = Math.round(w * s);
        th = Math.round(h * s);
    }

    const scaleCanvas = document.createElement('canvas');
    scaleCanvas.width = tw;
    scaleCanvas.height = th;
    const sctx = scaleCanvas.getContext('2d');
    sctx.drawImage(img, 0, 0, tw, th);

    const side = Math.min(tw, th);
    const sx = Math.floor((tw - side) / 2);
    const sy = Math.floor((th - side) / 2);

    const sq = document.createElement('canvas');
    sq.width = side;
    sq.height = side;
    const sqctx = sq.getContext('2d');
    sqctx.drawImage(scaleCanvas, sx, sy, side, side, 0, 0, side, side);

    const cell = side / 3;
    const m = cell * CELL_EDGE_TRIM;
    const inner = cell - 2 * m;
    const iw = Math.max(1, Math.floor(inner));

    const frames = [];
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            const x0 = c * cell + m;
            const y0 = r * cell + m;
            const fc = document.createElement('canvas');
            fc.width = iw;
            fc.height = iw;
            const fctx = fc.getContext('2d');
            fctx.drawImage(
                sq,
                Math.floor(x0),
                Math.floor(y0),
                Math.floor(inner),
                Math.floor(inner),
                0,
                0,
                iw,
                iw,
            );
            frames.push(fc);
        }
    }
    return frames;
}

/**
 * @param {HTMLCanvasElement[]} canvases 等宽高
 * @param {number} delayMs
 * @returns {Promise<Uint8Array>}
 */
export async function encodeAnimatedGifBytes(canvases, delayMs) {
    if (!canvases.length) throw new Error('无帧');
    const w = canvases[0].width;
    const h = canvases[0].height;
    for (const c of canvases) {
        if (c.width !== w || c.height !== h) throw new Error('帧尺寸不一致');
    }

    // esm.sh 的 gifenc 子包往往只透出 default，解构 GIFEncoder 会得到 undefined。
    // 使用 npm 发布的 dist/gifenc.esm.js，命名导出与源码一致。
    const mod = await import('https://unpkg.com/gifenc@1.0.3/dist/gifenc.esm.js');
    const GIFEncoder = mod.GIFEncoder ?? mod.default;
    const { quantize, applyPalette } = mod;
    if (typeof GIFEncoder !== 'function') throw new Error('gifenc: 无法加载 GIFEncoder');
    if (typeof quantize !== 'function' || typeof applyPalette !== 'function') {
        throw new Error('gifenc: 无法加载 quantize / applyPalette');
    }

    const gif = GIFEncoder();
    const d = clamp(Math.round(delayMs), FRAME_DELAY_MIN, FRAME_DELAY_MAX);

    for (let i = 0; i < canvases.length; i++) {
        const ctx = canvases[i].getContext('2d', { willReadFrequently: true });
        const { data } = ctx.getImageData(0, 0, w, h);
        const palette = quantize(data, 256, { format: 'rgb565' });
        const index = applyPalette(data, palette, 'rgb565');
        gif.writeFrame(index, w, h, {
            palette,
            delay: d,
            repeat: i === 0 ? 0 : undefined,
        });
    }
    gif.finish();
    return gif.bytes();
}

export function parseFrameDelayInput(raw) {
    const n = Number.parseInt(String(raw).trim(), 10);
    if (Number.isNaN(n)) return FRAME_DELAY_DEFAULT;
    return clamp(n, FRAME_DELAY_MIN, FRAME_DELAY_MAX);
}
