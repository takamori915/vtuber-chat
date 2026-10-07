// 写真キャラ：人物の切り抜きと口パク
import { extractPose } from './body-rig.js?v=22';
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

    // 口の中心の縦の列で、赤みの強い行（唇）を探し、その重心の高さを返す
    function findLipCenter() {
        const p = geo.pts;
        const cx = (p.mouthLeft.x + p.mouthRight.x) / 2;
        const hw = Math.max(2, (p.mouthRight.x - p.mouthLeft.x) / 2);
        const base = (p.upperLipInner.y + p.lowerLipInner.y) / 2;
        const y0 = Math.round(base - hw * 0.6), y1 = Math.round(base + hw * 0.4);
        const rows = [];
        for (let y = y0; y <= y1; y++) {
            let sum = 0, n = 0;
            for (let x = Math.round(cx - hw * 0.4); x <= Math.round(cx + hw * 0.4); x++) {
                const ix = Math.round(x + W / 2), iy = Math.round(y + H / 2);
                if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
                const i = (iy * W + ix) * 4;
                sum += src[i] - (src[i + 1] + src[i + 2]) / 2; // 赤み
                n++;
            }
            rows.push([y, n ? sum / n : 0]);
        }
        // 周りの肌よりはっきり赤い行だけで重心をとる
        const vals = rows.map((r) => r[1]).sort((a, b) => a - b);
        const skin = vals[Math.floor(vals.length * 0.3)];
        const peak = vals[vals.length - 1];
        if (peak - skin < 8) return null; // 唇がはっきりしない
        let sw = 0, sy = 0;
        for (const [y, v] of rows) {
            const w = Math.max(0, v - (skin + (peak - skin) * 0.45));
            sw += w;
            sy += w * y;
        }
        return sw ? sy / sw : null;
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
    // 回転後の座標 (x, y) の色
    function colorAt(x, y) {
        const ix = Math.round(x + W / 2), iy = Math.round(y + H / 2);
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) return null;
        const i = (iy * W + ix) * 4;
        return [src[i], src[i + 1], src[i + 2], src[i + 3]];
    }

    function averageColor(cx, cy, r) {
        let n = 0;
        const sum = [0, 0, 0];
        for (let y = cy - r; y <= cy + r; y++) {
            for (let x = cx - r; x <= cx + r; x++) {
                const c = colorAt(x, y);
                if (!c || c[3] < 200) continue;
                sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
                n++;
            }
        }
        return n ? sum.map((v) => v / n) : null;
    }

    // 画像から実際の目の大きさをはかる。検出される目の輪郭は、大きく描かれた目より小さいことが多いので、
    // 目の中心から上下左右に、頬の肌の色に戻るところまでを目とする
    function measureEye(side) {
        const p = geo.pts;
        const outer = p[`eye${side}Outer`], inner = p[`eye${side}Inner`];
        const cx = (outer.x + inner.x) / 2;
        const cy = (p[`eye${side}Top`].y + p[`eye${side}Bottom`].y) / 2;
        const ew = Math.abs(outer.x - inner.x);
        // 肌の色は、頬と両目の間（鼻すじ）の平均をとる（頬だけだと赤みが強く、まぶたに合わない）
        const cheek = averageColor(cx, Math.round(cy + ew * 0.75), Math.max(2, Math.round(ew * 0.12)));
        const midX = (p.eyeLInner.x + p.eyeRInner.x) / 2;
        const bridge = averageColor(Math.round(midX), Math.round(cy), Math.max(2, Math.round(ew * 0.1)));
        const skin = cheek && bridge ? cheek.map((v, i) => (v + bridge[i]) / 2) : cheek || bridge || [230, 200, 185];
        const isSkin = (c) => c && Math.hypot(c[0] - skin[0], c[1] - skin[1], c[2] - skin[2]) < 28;
        const scan = (dx, dy, max) => {
            let run = 0;
            for (let d = 1; d <= max; d++) {
                const c = colorAt(cx + dx * d, cy + dy * d);
                if (isSkin(c)) {
                    if (++run >= 3) return d - 2;
                } else run = 0;
            }
            return max;
        };
        // 前髪や眉まで覆わないよう、目の幅を基準に範囲を制限する
        const up = Math.min(Math.max(scan(0, -1, Math.round(ew * 0.9)), ew * 0.28), ew * 0.48);
        // 下まつ毛まで覆う（検出された下まぶたより少し下まで）
        const lidBottom = p[`eye${side}Bottom`].y - cy + ew * 0.18;
        const down = Math.min(Math.max(scan(0, 1, Math.round(ew * 0.9)), ew * 0.22, lidBottom), ew * 0.52);
        const half = Math.min(Math.max((scan(-1, 0, Math.round(ew)) + scan(1, 0, Math.round(ew))) / 2, ew * 0.5), ew * 0.62);
        const eye = { cx, cy: cy + (down - up) / 2, rx: half + 1, ry: (up + down) / 2 + 1, skin };
        // 覆う色は、楕円のすぐ外側の肌の色に合わせる（前髪やまつ毛など肌でない点は除く）
        const ring = [];
        for (let i = 0; i < 48; i++) {
            const a = (i / 48) * Math.PI * 2;
            const c = colorAt(eye.cx + Math.cos(a) * eye.rx * 1.3, eye.cy + Math.sin(a) * eye.ry * 1.3);
            if (c && c[3] > 200 && Math.hypot(c[0] - skin[0], c[1] - skin[1], c[2] - skin[2]) < 40) ring.push(c);
        }
        if (ring.length >= 8) eye.skin = [0, 1, 2].map((k) => ring.reduce((t, c) => t + c[k], 0) / ring.length);
        return eye;
    }

    // まばたき：肌の色で目を覆い、閉じたまつ毛の線を描く（lid が 0.5 を超えるとだんだん閉じる）
    function closeEye(side, lid) {
        const m = geo.eyes?.[side];
        if (!m) return;
        const t = Math.max(0, Math.min(1, (lid - 0.5) / 0.4));
        if (t <= 0) return;
        const k = t * t * (3 - 2 * t);
        const [r, gg, b] = m.skin;
        const top = `rgb(${r * 0.95},${gg * 0.93},${b * 0.93})`; // まぶたの上はほんの少し影
        const bottom = `rgb(${r},${gg},${b})`;
        g.save();
        // 縁をぼかすため、少し大きい楕円から薄く重ねる
        for (const [scale, a] of [[1.3, 0.12], [1.2, 0.2], [1.1, 0.35], [1.0, 1]]) {
            const grad = g.createLinearGradient(0, m.cy - m.ry * scale, 0, m.cy + m.ry * scale);
            grad.addColorStop(0, top);
            grad.addColorStop(1, bottom);
            g.globalAlpha = a * k;
            g.fillStyle = grad;
            g.beginPath();
            g.ellipse(m.cx, m.cy, m.rx * scale, m.ry * scale, 0, 0, Math.PI * 2);
            g.fill();
        }
        // 閉じたまつ毛の線（下向きのゆるいカーブ）
        g.globalAlpha = k;
        g.strokeStyle = 'rgba(58, 38, 32, 0.9)';
        g.lineWidth = Math.max(1.5, m.rx * 0.11);
        g.lineCap = 'round';
        const ly = m.cy + m.ry * 0.3;
        g.beginPath();
        g.moveTo(m.cx - m.rx * 0.95, ly - m.ry * 0.05);
        g.quadraticCurveTo(m.cx, ly + m.ry * 0.45, m.cx + m.rx * 0.95, ly - m.ry * 0.05);
        g.stroke();
        g.restore();
    }

    function warpEye(side, e) {
        const p = geo.pts;
        const outer = p[`eye${side}Outer`], inner = p[`eye${side}Inner`];
        const bIn = p[`brow${side}Inner`], bOut = p[`brow${side}Outer`];
        const browY = (p[`brow${side}Mid`].y + p[`brow${side}MidLow`].y) / 2;
        // 検出される目の輪郭は、大きく描かれた目（アニメ調やフィギュア）より少し小さいので、上下に少し広げる
        const rawTop = p[`eye${side}Top`].y, rawBot = p[`eye${side}Bottom`].y;
        const rawH = Math.max(2, rawBot - rawTop);
        const eyeTop = rawTop - rawH * 0.25, eyeBot = rawBot + rawH * 0.12;
        const eyeH = eyeBot - eyeTop;
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
        // 唇の色の帯の真ん中で開く（検出される「唇の合わせ目」は帯の下の端にずれていることがある）
        const lipY = geo.lipSplit ?? (p.upperLipInner.y + p.lowerLipInner.y) / 2;
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
            // まぶたのゆがみは細める程度まで。閉じるのは closeEye で目を覆って描く
            const half = (e) => ({ ...e, lid: Math.min(e.lid, 0.45) });
            warpEye('L', half(expr.L));
            warpEye('R', half(expr.R));
            closeEye('L', expr.L.lid);
            closeEye('R', expr.R.lid);
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
                geo.lipSplit = findLipCenter();
                if (geo.hasEyes) {
                    // 左右の目の大きさはそろえる
                    const L = measureEye('L'), R = measureEye('R');
                    const rx = (L.rx + R.rx) / 2, ry = (L.ry + R.ry) / 2;
                    geo.eyes = { L: { ...L, rx, ry }, R: { ...R, rx, ry } };
                }
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
