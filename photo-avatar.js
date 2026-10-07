// 写真キャラ：人物の切り抜きと口パク
import { extractPose } from './body-rig.js?v=13';
// MediaPipe（Google）の画像処理をブラウザ内で動かすので、写真は外部に送られない。
// 必要なモデルは初回だけダウンロードされ、以降はブラウザのキャッシュから読み込まれる。

const MP_VERSION = '1.1.0';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODELS = {
    face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    // 人物（髪・服も含む）を背景から分けるモデル
    segment: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
    // 肩・ひじ・手首・腰・ひざ・足首の位置（手足を動かすのに使う）
    pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

// 顔のランドマーク番号（MediaPipe Face Mesh）
const LM = {
    mouthLeft: 61,
    mouthRight: 291,
    upperLipInner: 13,
    lowerLipInner: 14,
    chin: 152,
    nose: 1,
    faceLeft: 234,
    faceRight: 454,
    // 目（画像の左右）：外側・内側の端と、上まぶた・下まぶたの中央
    eyeLOuter: 33, eyeLInner: 133, eyeLTop: 159, eyeLBottom: 145,
    eyeROuter: 263, eyeRInner: 362, eyeRTop: 386, eyeRBottom: 374,
    // 眉（画像の左右）：内側・外側の端と、中央の上下
    browLInner: 55, browLOuter: 46, browLMid: 105, browLMidLow: 52,
    browRInner: 285, browROuter: 276, browRMid: 334, browRMidLow: 282,
};

let visionPromise = null;

function loadVision() {
    if (!visionPromise) {
        visionPromise = (async () => {
            const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
            const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
            const [face, segmenter, pose] = await Promise.all([
                vision.FaceLandmarker.createFromOptions(fileset, {
                    baseOptions: { modelAssetPath: MODELS.face, delegate: 'CPU' },
                    runningMode: 'IMAGE',
                    numFaces: 5,
                }),
                vision.ImageSegmenter.createFromOptions(fileset, {
                    baseOptions: { modelAssetPath: MODELS.segment, delegate: 'CPU' },
                    runningMode: 'IMAGE',
                    outputConfidenceMasks: true,
                    outputCategoryMask: false,
                }),
                vision.PoseLandmarker.createFromOptions(fileset, {
                    baseOptions: { modelAssetPath: MODELS.pose, delegate: 'CPU' },
                    runningMode: 'IMAGE',
                    numPoses: 1,
                }),
            ]);
            return { face, segmenter, pose };
        })().catch((err) => {
            visionPromise = null; // 次回やり直せるように
            throw err;
        });
    }
    return visionPromise;
}

// いちばん大きく写っている顔を選ぶ
function pickMainFace(faces, w, h) {
    let best = null;
    let bestArea = 0;
    for (const lm of faces) {
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        for (const p of lm) {
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
        const area = (maxX - minX) * w * (maxY - minY) * h;
        if (area > bestArea) {
            bestArea = area;
            best = lm;
        }
    }
    return best;
}

// 顔のある人物だけを残す（後ろに写っている別の人を消す）
function keepComponent(alpha, w, h, seedX, seedY) {
    const on = new Uint8Array(w * h);
    for (let i = 0; i < on.length; i++) on[i] = alpha[i] > 0.5 ? 1 : 0;

    // 顔の位置から塗りつぶしでつながっている部分を探す
    const keep = new Uint8Array(w * h);
    let sx = Math.round(seedX), sy = Math.round(seedY);
    if (!on[sy * w + sx]) {
        // 顔の中心がちょうど抜けていたら、近くの人物部分から始める
        let found = false;
        for (let r = 1; r < 40 && !found; r++) {
            for (let dy = -r; dy <= r && !found; dy++) {
                for (let dx = -r; dx <= r && !found; dx++) {
                    const x = sx + dx, y = sy + dy;
                    if (x >= 0 && y >= 0 && x < w && y < h && on[y * w + x]) { sx = x; sy = y; found = true; }
                }
            }
        }
        if (!found) return alpha; // 見つからなければそのまま
    }
    const stack = [sy * w + sx];
    keep[sy * w + sx] = 1;
    while (stack.length) {
        const i = stack.pop();
        const x = i % w, y = (i / w) | 0;
        const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of next) {
            if (j >= 0 && on[j] && !keep[j]) { keep[j] = 1; stack.push(j); }
        }
    }

    // 境目をなめらかにするため、残す範囲を少し広げてから元の透明度を使う
    const grow = 3;
    const near = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!keep[y * w + x]) continue;
            for (let dy = -grow; dy <= grow; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -grow; dx <= grow; dx++) {
                    const xx = x + dx;
                    if (xx >= 0 && xx < w) near[yy * w + xx] = 1;
                }
            }
        }
    }
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = near[i] ? alpha[i] : 0;
    return out;
}

// 写真を処理して、表示用の画像と口の位置を返す
// canvas: 切り抜き枠の大きさに整えた写真
export async function processPhoto(canvas, { cutout = true } = {}) {
    const { face, segmenter, pose } = await loadVision();
    const w = canvas.width, h = canvas.height;

    const faces = face.detect(canvas).faceLandmarks || [];
    const lm = pickMainFace(faces, w, h);
    const facePoints = lm ? Object.fromEntries(Object.entries(LM).map(([k, i]) => [k, { x: lm[i].x, y: lm[i].y }])) : null;

    let image;
    let isCutout = false;
    let headTop = 0; // 頭のてっぺん（0〜1）。猫耳の位置合わせに使う
    if (cutout) {
        const result = segmenter.segment(canvas);
        const masks = result.confidenceMasks || [];
        if (masks.length) {
            const mask = masks[0];
            const raw = mask.getAsFloat32Array();
            // 複数分類モデルは0番が「背景」、人物だけのモデルは0番が「人物」
            let alpha = Float32Array.from(raw, (v) => (masks.length > 1 ? 1 - v : v));
            const mw = mask.width, mh = mask.height;
            if (facePoints) alpha = keepComponent(alpha, mw, mh, facePoints.nose.x * mw, facePoints.nose.y * mh);
            image = applyAlpha(canvas, alpha, mw, mh);
            isCutout = true;
            headTop = findHeadTop(alpha, mw, mh, facePoints);
        }
        result.close?.();
    }
    if (!image) image = canvas.toDataURL('image/jpeg', 0.85);

    let posePoints = null;
    try {
        posePoints = extractPose(pose.detect(canvas).landmarks?.[0]);
    } catch (err) {
        console.warn('体の位置が分かりませんでした', err);
    }
    return { image, cutout: isCutout, face: facePoints, headTop, pose: posePoints };
}

// 顔の真上で、人物が始まる高さを探す
function findHeadTop(alpha, w, h, face) {
    const cx = face ? face.nose.x : 0.5;
    const half = face ? Math.abs(face.faceRight.x - face.faceLeft.x) / 4 : 0.15;
    const x0 = Math.max(0, Math.floor((cx - half) * w));
    const x1 = Math.min(w - 1, Math.ceil((cx + half) * w));
    for (let y = 0; y < h; y++) {
        for (let x = x0; x <= x1; x++) {
            if (alpha[y * w + x] > 0.5) return y / h;
        }
    }
    return 0;
}

function applyAlpha(canvas, alpha, mw, mh) {
    const w = canvas.width, h = canvas.height;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const g = out.getContext('2d');
    g.drawImage(canvas, 0, 0);
    const img = g.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y++) {
        const my = Math.min(mh - 1, Math.floor((y / h) * mh));
        for (let x = 0; x < w; x++) {
            const mx = Math.min(mw - 1, Math.floor((x / w) * mw));
            img.data[(y * w + x) * 4 + 3] = Math.round(clamp01(alpha[my * mw + mx]) * 255);
        }
    }
    g.putImageData(img, 0, 0);
    // 透明部分を残すため PNG で保存する
    return out.toDataURL('image/png');
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ===== 表示（毎フレームの描画） =====
// 保存しておいた写真から下地を作り、表情（眉・まぶた・口）に合わせて描き直す。
//
// 変形は「1ピクセルごとに、上下方向へなめらかにずらす」方法で行う。
// 縦の各列について、いくつかの高さでのずれ量を決め、その間をなめらかにつなぐ。
// 列ごとのずれ量も左右に向かってなめらかに 0 へ戻すので、継ぎ目や折れ目が出ない。
// 顔が傾いていても自然に動くよう、目（または口）の傾きに合わせて回転した座標で計算する。
export function createPhotoRenderer(canvas) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    let base = null; // 影を付けた下地
    let src = null; // 顔の傾きを打ち消すように回転した下地のピクセル
    let geo = null; // 顔の傾きと、回転後の座標での各点
    let lastKey = '';
    const patch = document.createElement('canvas');
    const pg = patch.getContext('2d');

    function newCanvas() {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        return c;
    }

    function makeBase(img, cutout) {
        const c = newCanvas();
        const b = c.getContext('2d');
        if (cutout) {
            // 影は CSS で付ける（画像に描き込むと、手足を曲げたときに影まで伸びてしまう）
            b.drawImage(img, 0, 0, W, H);
        } else {
            // 枠線なしの角丸
            const r = 56;
            b.beginPath();
            b.moveTo(r, 0);
            b.arcTo(W, 0, W, H, r);
            b.arcTo(W, H, 0, H, r);
            b.arcTo(0, H, 0, 0, r);
            b.arcTo(0, 0, W, 0, r);
            b.closePath();
            b.clip();
            b.drawImage(img, 0, 0, W, H);
        }
        return c;
    }

    // 顔の傾きを求め、各点を「鼻を原点・目が水平」の座標に直す
    function prepare(face) {
        const P = (k) => (face[k] ? { x: face[k].x * W, y: face[k].y * H } : null);
        const hasEyes = Boolean(face.eyeLOuter && face.browLInner);
        const A = hasEyes ? P('eyeLOuter') : P('mouthLeft');
        const B = hasEyes ? P('eyeROuter') : P('mouthRight');
        const theta = Math.atan2(B.y - A.y, B.x - A.x);
        const fc = P('nose');
        const c = Math.cos(-theta), sn = Math.sin(-theta);
        const pts = {};
        for (const k of Object.keys(face)) {
            const p = P(k);
            const dx = p.x - fc.x, dy = p.y - fc.y;
            pts[k] = { x: dx * c - dy * sn, y: dx * sn + dy * c };
        }
        const io = hasEyes ? Math.abs(pts.eyeROuter.x - pts.eyeLOuter.x) : Math.abs(pts.mouthRight.x - pts.mouthLeft.x) * 2;
        return { theta, fc, pts, hasEyes, io };
    }

    function makeSource() {
        const c = newCanvas();
        const a = c.getContext('2d');
        a.translate(W / 2, H / 2);
        a.rotate(-geo.theta);
        a.translate(-geo.fc.x, -geo.fc.y);
        a.drawImage(base, 0, 0);
        return a.getImageData(0, 0, W, H).data;
    }

    // 回転後の座標 (x, y) の色をなめらかに（4点の平均で）取り出す
    function sample(x, y, out, o) {
        x += W / 2;
        y += H / 2;
        if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) {
            out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
            return;
        }
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i = (y0 * W + x0) * 4, j = i + W * 4;
        for (let c = 0; c < 4; c++) {
            const top = src[i + c] + (src[i + 4 + c] - src[i + c]) * fx;
            const bot = src[j + c] + (src[j + 4 + c] - src[j + c]) * fx;
            out[o + c] = top + (bot - top) * fy;
        }
    }

    // knots: [描く位置のy, ずれ量] の並び（上から順）。間をなめらかにつなぐ
    function displacement(knots, y) {
        if (y <= knots[0][0]) return knots[0][1];
        for (let k = 0; k < knots.length - 1; k++) {
            const [y0, d0] = knots[k];
            const [y1, d1] = knots[k + 1];
            if (y <= y1) {
                const t = y1 > y0 ? (y - y0) / (y1 - y0) : 1;
                // 直線とS字の中間：なめらかで、引き伸ばしすぎても折り返さない
                const s = 0.5 * t + 0.5 * t * t * (3 - 2 * t);
                return d0 + (d1 - d0) * s;
            }
        }
        return knots[knots.length - 1][1];
    }

    // 回転後の座標で矩形の範囲を変形して描く。
    // column(x) は { knots, gap?: [上, 下], interior?(x, y, out, o) } を返す
    function warpRegion(x0, y0, x1, y1, column) {
        x0 = Math.floor(x0); y0 = Math.floor(y0);
        x1 = Math.ceil(x1); y1 = Math.ceil(y1);
        const w = x1 - x0, h = y1 - y0;
        if (w < 4 || h < 4) return;
        if (patch.width !== w || patch.height !== h) {
            patch.width = w;
            patch.height = h;
        }
        const img = pg.createImageData(w, h);
        const d = img.data;
        const feather = 6; // 端はぼかして下地となじませる
        for (let i = 0; i < w; i++) {
            const x = x0 + i + 0.5;
            const col = column(x);
            const ex = Math.min(i, w - 1 - i) / feather;
            for (let j = 0; j < h; j++) {
                const y = y0 + j + 0.5;
                const o = (j * w + i) * 4;
                const gap = col.gap;
                if (gap && y > gap[0] && y < gap[1]) {
                    col.interior(x, y, d, o);
                    // 唇との境目を1ピクセルぶんなめらかに
                    const edge = Math.min(y - gap[0], gap[1] - y);
                    if (edge < 1) {
                        const r = d[o], gg = d[o + 1], b = d[o + 2];
                        sample(x, y - displacement(col.knots, y < (gap[0] + gap[1]) / 2 ? gap[0] : gap[1]), d, o);
                        d[o] = r + (d[o] - r) * (1 - edge);
                        d[o + 1] = gg + (d[o + 1] - gg) * (1 - edge);
                        d[o + 2] = b + (d[o + 2] - b) * (1 - edge);
                        d[o + 3] = 255;
                    }
                } else {
                    sample(x, y - displacement(col.knots, y), d, o);
                }
                const a = Math.min(1, ex, Math.min(j, h - 1 - j) / feather);
                if (a < 1) d[o + 3] *= a;
            }
        }
        pg.putImageData(img, 0, 0);
        g.drawImage(patch, x0, y0);
    }

    // 中央が 1、端に向かってなめらかに 0 になる重み（|v| < flat の間は 1）
    function taper(v, flat = 0) {
        const a = Math.abs(v);
        if (a <= flat) return 1;
        if (a >= 1) return 0;
        return 0.5 * (1 + Math.cos(Math.PI * (a - flat) / (1 - flat)));
    }

    // 片目ぶん：眉の上下（内側・外側）と、上まぶたの上下
    // e: { bi: 眉の内側, bo: 眉の外側（+で下がる）, lid: まぶた（+で閉じる、-で見開く） }
    function warpEye(side, e) {
        const p = geo.pts;
        const outer = p[`eye${side}Outer`], inner = p[`eye${side}Inner`];
        const bIn = p[`brow${side}Inner`], bOut = p[`brow${side}Outer`];
        const browY = (p[`brow${side}Mid`].y + p[`brow${side}MidLow`].y) / 2;
        const eyeTop = p[`eye${side}Top`].y, eyeBot = p[`eye${side}Bottom`].y;
        const eyeH = Math.max(2, eyeBot - eyeTop);
        const gap = Math.max(4, eyeTop - browY);
        const unit = geo.io * 0.075; // 眉を動かす量の単位
        if (Math.max(Math.abs(e.bi), Math.abs(e.bo)) * unit < 0.3 && Math.abs(e.lid) * eyeH < 0.3) return;

        const regionTop = browY - gap * 1.4;
        const regionBottom = eyeBot + geo.io * 0.12;
        const xs = [outer.x, inner.x, bIn.x, bOut.x];
        const xMin = Math.min(...xs) - geo.io * 0.08;
        const xMax = Math.max(...xs) + geo.io * 0.08;
        const xMid = (xMin + xMax) / 2, half = (xMax - xMin) / 2;
        const eyeCx = (outer.x + inner.x) / 2, eyeHalf = Math.abs(outer.x - inner.x) / 2;

        warpRegion(xMin, regionTop, xMax, regionBottom, (x) => {
            const t = clamp01((x - bIn.x) / (bOut.x - bIn.x)); // 眉の内側0〜外側1
            // 眉が目に近い顔でも、まぶたまで押し下げないよう下げ幅を眉と目の間隔で抑える
            let bs = Math.max(-gap, Math.min(gap * 0.4, (e.bi * (1 - t) + e.bo * t) * unit)) * taper((x - xMid) / half, 0.5);
            let ls = e.lid * eyeH * taper((x - eyeCx) / (eyeHalf * 1.35), 0.2);
            // 並び順が入れ替わらないように制限する（描く位置で）
            let dBrow = browY + bs;
            let dTop = Math.min(eyeTop + ls, eyeBot - 0.6);
            dBrow = Math.max(Math.min(dBrow, dTop - 2), regionTop + 2);
            dTop = Math.max(dTop, dBrow + 2);
            return {
                knots: [[regionTop, 0], [dBrow, dBrow - browY], [dTop, dTop - eyeTop], [eyeBot, 0], [regionBottom, 0]],
            };
        });
    }

    // 口：上唇を少し上げ、下唇から下をなめらかに下げて、すき間に口の中を描く
    function warpMouth(level) {
        const p = geo.pts;
        const L = p.mouthLeft, R = p.mouthRight;
        const cx = (L.x + R.x) / 2;
        const lipY = (p.upperLipInner.y + p.lowerLipInner.y) / 2;
        const hw = Math.max(2, (R.x - L.x) / 2);
        const open = level * hw * 0.7;
        if (open < 0.3) return;
        const topY = lipY - Math.max(6, lipY - p.nose.y) * 0.75; // 鼻の下あたりまで
        const bottom = p.chin.y + (p.chin.y - lipY) * 0.5; // あごの少し下まで
        const midDown = lipY + (bottom - lipY) * 0.45;

        warpRegion(cx - hw * 1.3, topY, cx + hw * 1.3, bottom, (x) => {
            const o = open * taper((x - cx) / (hw * 1.12), 0.12);
            const up = o * 0.22, down = o * 0.78;
            const knots = [[topY, 0], [lipY - up, -up], [lipY + down, down], [midDown + down * 0.5, down * 0.45], [bottom, 0]];
            if (o < 0.4) return { knots };
            return {
                knots,
                gap: [lipY - up, lipY + down],
                interior(px, py, out, oi) {
                    // 奥ほど暗い口の中と、下のほうに少しだけ見える舌
                    const r = (py - (lipY - up)) / (up + down);
                    let cr = 43 + 49 * r, cg = 11 + 20 * r, cb = 18 + 25 * r;
                    const tx = (px - cx) / (hw * 0.6), ty = (r - 1) / 0.5;
                    const q = tx * tx + ty * ty;
                    if (q < 1) {
                        const a = 0.7 * Math.sqrt(1 - q);
                        cr += (190 - cr) * a; cg += (86 - cg) * a; cb += (104 - cb) * a;
                    }
                    out[oi] = cr; out[oi + 1] = cg; out[oi + 2] = cb; out[oi + 3] = 255;
                },
            };
        });
    }

    // expr: { mouth: 0〜1, L: {bi, bo, lid}, R: {bi, bo, lid} }
    function render(expr) {
        if (!base) return;
        g.clearRect(0, 0, W, H);
        g.drawImage(base, 0, 0);
        if (!geo) return;
        g.save();
        g.translate(geo.fc.x, geo.fc.y);
        g.rotate(geo.theta);
        if (geo.hasEyes) {
            warpEye('L', expr.L);
            warpEye('R', expr.R);
        }
        warpMouth(expr.mouth);
        g.restore();
    }

    return {
        async load(data) {
            base = null;
            src = null;
            geo = null;
            lastKey = '';
            if (!data) {
                g.clearRect(0, 0, W, H);
                return;
            }
            const img = new Image();
            img.src = data.image;
            await img.decode();
            base = makeBase(img, data.cutout);
            if (data.face) {
                geo = prepare(data.face);
                src = makeSource();
            }
            render({ mouth: 0, L: { bi: 0, bo: 0, lid: 0 }, R: { bi: 0, bo: 0, lid: 0 } });
        },
        get hasFace() { return Boolean(geo); },
        // 目・眉が動かせるか（以前に保存した写真には目の位置が入っていない）
        get hasEyes() { return Boolean(geo?.hasEyes); },
        // 値が変わったときだけ描き直す
        update(expr) {
            const q = (v) => Math.round(v * 60);
            const key = [expr.mouth, expr.L.bi, expr.L.bo, expr.L.lid, expr.R.bi, expr.R.bo, expr.R.lid].map(q).join(',');
            if (key === lastKey) return;
            lastKey = key;
            render(expr);
        },
    };
}
