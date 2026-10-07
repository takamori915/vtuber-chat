// 写真キャラ：人物の切り抜きと口パク
// MediaPipe（Google）の画像処理をブラウザ内で動かすので、写真は外部に送られない。
// 必要なモデルは初回だけダウンロードされ、以降はブラウザのキャッシュから読み込まれる。

const MP_VERSION = '1.1.0';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODELS = {
    face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    // 人物（髪・服も含む）を背景から分けるモデル
    segment: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
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
            const [face, segmenter] = await Promise.all([
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
            ]);
            return { face, segmenter };
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
    const { face, segmenter } = await loadVision();
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
    return { image, cutout: isCutout, face: facePoints, headTop };
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
// 顔が傾いていても自然に動くよう、目（または口）の傾きに合わせて回転した座標で変形する。
//
// 変形は「縦の細い帯ごとに、上下方向だけ伸び縮みさせる」方法で行う：
// 帯ごとに [元の高さ → 描く高さ] の対応点を決め、区間ごとに drawImage で引き伸ばす。
// 中央ほど大きく、端に向かってなめらかに 0 に戻すので、継ぎ目が出ない。
export function createPhotoRenderer(canvas) {
    const g = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    let base = null; // 縁取りなどを付けた下地
    let aligned = null; // 顔の傾きを打ち消すように回転した下地
    let geo = null; // 顔の傾きと、回転後の座標での各点
    let lastKey = '';

    function makeBase(img, cutout) {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const b = c.getContext('2d');
        if (cutout) {
            // シール風の白い縁取り
            const r = 7;
            const ring = document.createElement('canvas');
            ring.width = W;
            ring.height = H;
            const rg = ring.getContext('2d');
            for (let a = 0; a < 16; a++) {
                const t = (a / 16) * Math.PI * 2;
                rg.drawImage(img, Math.cos(t) * r, Math.sin(t) * r, W, H);
            }
            rg.globalCompositeOperation = 'source-in';
            rg.fillStyle = '#ffffff';
            rg.fillRect(0, 0, W, H);
            b.shadowColor = 'rgba(0,0,0,0.35)';
            b.shadowBlur = 18;
            b.shadowOffsetY = 6;
            b.drawImage(ring, 0, 0);
            b.shadowColor = 'transparent';
            b.drawImage(img, 0, 0, W, H);
        } else {
            // 角丸の枠に入れる
            const m = 8, rad = 64;
            b.fillStyle = '#ffffff';
            roundRect(b, 0, 0, W, H, rad + m);
            b.fill();
            b.save();
            roundRect(b, m, m, W - m * 2, H - m * 2, rad);
            b.clip();
            b.drawImage(img, 0, 0, W, H);
            b.restore();
            b.strokeStyle = '#ff8fb8';
            b.lineWidth = 5;
            roundRect(b, 2.5, 2.5, W - 5, H - 5, rad + m);
            b.stroke();
        }
        return c;
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
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

    function makeAligned() {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const a = c.getContext('2d');
        a.translate(W / 2, H / 2);
        a.rotate(-geo.theta);
        a.translate(-geo.fc.x, -geo.fc.y);
        a.drawImage(base, 0, 0);
        return c;
    }

    // 帯ごとの縦方向の伸び縮み。knotsAt(x) は [元のy, 描くy] の並び（上から順）
    function columnWarp(x0, x1, knotsAt, step = 2) {
        for (let x = Math.floor(x0); x < x1; x += step) {
            const k = knotsAt(x + step / 2);
            if (!k || k.every(([sy, dy]) => Math.abs(dy - sy) < 0.3)) continue;
            for (let i = 0; i < k.length - 1; i++) {
                const [sy0, dy0] = k[i];
                const [sy1, dy1] = k[i + 1];
                if (sy1 - sy0 < 0.5 || dy1 - dy0 < 0.5) continue;
                g.drawImage(aligned, x + W / 2, sy0 + H / 2, step, sy1 - sy0, x, dy0, step, dy1 - dy0);
            }
        }
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
        const top = p[`eye${side}Top`], bottom = p[`eye${side}Bottom`];
        const bIn = p[`brow${side}Inner`], bOut = p[`brow${side}Outer`];
        const browY = (p[`brow${side}Mid`].y + p[`brow${side}MidLow`].y) / 2;
        const eyeTop = top.y, eyeBot = bottom.y;
        const eyeH = Math.max(2, eyeBot - eyeTop);
        const gap = Math.max(4, eyeTop - browY);
        const regionTop = browY - gap * 1.1;
        const regionBottom = eyeBot + geo.io * 0.1;
        const unit = geo.io * 0.075; // 眉を動かす量の単位
        const xs = [outer.x, inner.x, bIn.x, bOut.x];
        const xMin = Math.min(...xs) - geo.io * 0.06;
        const xMax = Math.max(...xs) + geo.io * 0.06;
        const xMid = (xMin + xMax) / 2, half = (xMax - xMin) / 2;
        const eyeCx = (outer.x + inner.x) / 2, eyeHalf = Math.abs(outer.x - inner.x) / 2;

        columnWarp(xMin, xMax, (x) => {
            const t = clamp01((x - bIn.x) / (bOut.x - bIn.x)); // 眉の内側0〜外側1
            // 眉が目に近い顔でも、まぶたまで押し下げないよう下げ幅を眉と目の間隔で抑える
            const bs = Math.max(-gap, Math.min(gap * 0.4, (e.bi * (1 - t) + e.bo * t) * unit)) * taper((x - xMid) / half, 0.55);
            let ls = e.lid * eyeH * taper((x - eyeCx) / (eyeHalf * 1.3), 0.25);
            // 並び順が入れ替わらないように制限する
            let dBrow = browY + bs;
            let dTop = eyeTop + ls;
            dTop = Math.min(dTop, eyeBot - 0.6);
            dBrow = Math.min(dBrow, dTop - 2);
            dBrow = Math.max(dBrow, regionTop + 2);
            dTop = Math.max(dTop, dBrow + 2);
            return [[regionTop, regionTop], [browY, dBrow], [eyeTop, dTop], [eyeBot, eyeBot], [regionBottom, regionBottom]];
        }, 2);
    }

    // 口：下唇から下を下げて、そのすき間に口の中を描く
    function drawMouth(level) {
        const p = geo.pts;
        const L = p.mouthLeft, R = p.mouthRight;
        const cx = (L.x + R.x) / 2;
        const lipY = (p.upperLipInner.y + p.lowerLipInner.y) / 2;
        const mouthW = Math.max(4, R.x - L.x);
        const open = level * mouthW * 0.32;
        const bottom = p.chin.y + (p.chin.y - lipY) * 0.6;
        const span = mouthW * 1.1;

        g.save();
        g.beginPath();
        g.moveTo(L.x, L.y);
        g.quadraticCurveTo(cx, lipY - open * 0.15, R.x, R.y);
        g.quadraticCurveTo(cx, lipY + open * 1.9, L.x, L.y);
        g.closePath();
        const grad = g.createLinearGradient(0, lipY, 0, lipY + open);
        grad.addColorStop(0, '#2b0b12');
        grad.addColorStop(1, '#5c1f2b');
        g.fillStyle = grad;
        g.shadowColor = '#3a1018';
        g.shadowBlur = 3;
        g.fill();
        g.clip();
        // 舌（奥のほうに少しだけ見える）
        g.shadowBlur = 0;
        g.beginPath();
        g.ellipse(cx, lipY + open * 1.05, mouthW * 0.24, open * 0.32, 0, 0, Math.PI * 2);
        g.fillStyle = 'rgba(190, 86, 104, 0.75)';
        g.fill();
        g.restore();

        columnWarp(cx - span, cx + span, (x) => {
            const s = open * taper((x - cx) / span);
            return [[lipY, lipY + s], [bottom, bottom]];
        }, 2);
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
        if (expr.mouth > 0.02) drawMouth(expr.mouth);
        g.restore();
    }

    return {
        async load(data) {
            base = null;
            aligned = null;
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
                aligned = makeAligned();
            }
            render({ mouth: 0, L: { bi: 0, bo: 0, lid: 0 }, R: { bi: 0, bo: 0, lid: 0 } });
        },
        get hasFace() { return Boolean(geo); },
        // 目・眉が動かせるか（以前に保存した写真には目の位置が入っていない）
        get hasEyes() { return Boolean(geo?.hasEyes); },
        // 値が変わったときだけ描き直す
        update(expr) {
            const q = (v) => Math.round(v * 30);
            const key = [expr.mouth, expr.L.bi, expr.L.bo, expr.L.lid, expr.R.bi, expr.R.bo, expr.R.lid].map(q).join(',');
            if (key === lastKey) return;
            lastKey = key;
            render(expr);
        },
    };
}
