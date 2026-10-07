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
// 保存しておいた写真から下地を作り、口の開き具合に合わせて描き直す
export function createPhotoRenderer(canvas) {
    const g = canvas.getContext('2d');
    let base = null; // 縁取りなどを付けた下地
    let face = null;
    let lastLevel = -1;

    function makeBase(img, cutout) {
        const w = canvas.width, h = canvas.height;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const b = c.getContext('2d');
        if (cutout) {
            // シール風の白い縁取り
            const r = 7;
            const ring = document.createElement('canvas');
            ring.width = w;
            ring.height = h;
            const rg = ring.getContext('2d');
            for (let a = 0; a < 16; a++) {
                const t = (a / 16) * Math.PI * 2;
                rg.drawImage(img, Math.cos(t) * r, Math.sin(t) * r, w, h);
            }
            rg.globalCompositeOperation = 'source-in';
            rg.fillStyle = '#ffffff';
            rg.fillRect(0, 0, w, h);
            b.shadowColor = 'rgba(0,0,0,0.35)';
            b.shadowBlur = 18;
            b.shadowOffsetY = 6;
            b.drawImage(ring, 0, 0);
            b.shadowColor = 'transparent';
            b.drawImage(img, 0, 0, w, h);
        } else {
            // 角丸の枠に入れる
            const m = 8, rad = 64;
            b.fillStyle = '#ffffff';
            roundRect(b, 0, 0, w, h, rad + m);
            b.fill();
            b.save();
            roundRect(b, m, m, w - m * 2, h - m * 2, rad);
            b.clip();
            b.drawImage(img, 0, 0, w, h);
            b.restore();
            b.strokeStyle = '#ff8fb8';
            b.lineWidth = 5;
            roundRect(b, 2.5, 2.5, w - 5, h - 5, rad + m);
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

    function render(level) {
        if (!base) return;
        const w = canvas.width, h = canvas.height;
        g.clearRect(0, 0, w, h);
        g.drawImage(base, 0, 0);
        if (!face || level < 0.02) return;

        // 口の位置（ピクセル）
        const L = { x: face.mouthLeft.x * w, y: face.mouthLeft.y * h };
        const R = { x: face.mouthRight.x * w, y: face.mouthRight.y * h };
        const cx = (L.x + R.x) / 2;
        const lipY = ((face.upperLipInner.y + face.lowerLipInner.y) / 2) * h;
        const chinY = face.chin.y * h;
        const mouthW = Math.hypot(R.x - L.x, R.y - L.y);
        const open = level * mouthW * 0.42;
        const bottom = Math.min(h, chinY + (chinY - lipY) * 0.7);
        const span = mouthW * 1.15; // 下あごを動かす左右の範囲

        // 口の中：上唇のラインと、下がった下唇のラインで囲んだ形にする
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

        // 下唇から下を、中央ほど大きく下にずらす（端は動かさないので裂け目が出ない）
        const step = 2;
        for (let x = Math.floor(cx - span); x < cx + span; x += step) {
            const t = (x - cx) / span;
            const s = open * 0.5 * (1 + Math.cos(Math.PI * t));
            if (s < 0.3) continue;
            g.drawImage(base, x, lipY, step, bottom - lipY, x, lipY + s, step, bottom - lipY - s);
        }
    }

    return {
        async load(data) {
            base = null;
            face = null;
            lastLevel = -1;
            if (!data) {
                g.clearRect(0, 0, canvas.width, canvas.height);
                return;
            }
            const img = new Image();
            img.src = data.image;
            await img.decode();
            base = makeBase(img, data.cutout);
            face = data.face || null;
            render(0);
        },
        get hasMouth() { return Boolean(face); },
        // 口の開き具合（0〜1）を受け取り、変わったときだけ描き直す
        update(level) {
            const q = Math.round(level * 40) / 40;
            if (q === lastLevel) return;
            lastLevel = q;
            render(q);
        },
    };
}
