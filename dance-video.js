// 踊るときの動画：登録した動画から人物だけを切り抜いて再生する
// 背景の消し方は「緑の背景（グリーンバック）を消す」か「AIで人物を切り抜く」のどちらか。
// 動画はこの端末のブラウザ（IndexedDB）にだけ保存し、外部には送らない。

const DB_NAME = 'vtuberChat';
const STORE = 'files';
const KEY = 'danceVideo';
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0';
// 動画は毎フレーム処理するので、軽い人物切り抜きモデルを使う
const SEGMENT_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const MAX_W = 360, MAX_H = 640; // 処理する大きさ（大きいと重くなる）

// ===== 保存（IndexedDB） =====
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbRequest(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
    });
}

// record: { blob, chroma: 緑背景を消すか, sound: 音を流すか, name }
export const saveDanceVideo = (record) => dbRequest('readwrite', (s) => s.put(record, KEY));
export const loadDanceVideo = () => dbRequest('readonly', (s) => s.get(KEY)).catch(() => null);
export const deleteDanceVideo = () => dbRequest('readwrite', (s) => s.delete(KEY));

// ===== AIでの人物切り抜き（動画用） =====
let segmenterPromise = null;
function loadSegmenter() {
    if (!segmenterPromise) {
        segmenterPromise = (async () => {
            const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
            const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
            const create = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: SEGMENT_MODEL, delegate },
                runningMode: 'VIDEO',
                outputConfidenceMasks: true,
                outputCategoryMask: false,
            });
            // GPU が使えれば速い。だめなら CPU で
            try {
                return await create('GPU');
            } catch {
                return await create('CPU');
            }
        })().catch((err) => {
            segmenterPromise = null;
            throw err;
        });
    }
    return segmenterPromise;
}

// ===== 再生 =====
export function createDanceVideoPlayer(canvas) {
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const video = document.createElement('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    const maskCanvas = document.createElement('canvas');
    const mg = maskCanvas.getContext('2d');
    let record = null;
    let url = null;
    let playing = false;
    let finish = null;
    let segmenter = null;
    let lastTs = -1;

    async function setRecord(r) {
        stop();
        if (url) URL.revokeObjectURL(url);
        url = null;
        record = r || null;
        if (!record) return;
        url = URL.createObjectURL(record.blob);
        video.src = url;
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('動画を読み込めませんでした'));
        });
        const k = Math.min(1, MAX_W / video.videoWidth, MAX_H / video.videoHeight);
        canvas.width = Math.round(video.videoWidth * k);
        canvas.height = Math.round(video.videoHeight * k);
        if (!record.chroma) {
            // 再生前に準備しておく（初回はダウンロードがある）
            loadSegmenter().then((s) => { segmenter = s; }).catch((err) => console.warn('人物の切り抜きを準備できませんでした', err));
        }
    }

    // 緑の背景を透明にする
    function chromaKey() {
        const img = g.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], gr = d[i + 1], b = d[i + 2];
            const excess = gr - Math.max(r, b); // 緑がどれだけ強いか
            if (excess > 20 && gr > 60) {
                // 境目はなめらかに透明にする
                d[i + 3] = Math.max(0, 255 - (excess - 20) * 8);
                // 縁に残る緑っぽさを抑える
                d[i + 1] = Math.max(r, b);
            }
        }
        g.putImageData(img, 0, 0);
    }

    // AIで人物以外を透明にする
    function segmentFrame() {
        if (!segmenter) return;
        const ts = performance.now();
        if (ts <= lastTs) return;
        lastTs = ts;
        const result = segmenter.segmentForVideo(video, ts);
        const mask = result.confidenceMasks?.[0];
        if (mask) {
            const mw = mask.width, mh = mask.height;
            const values = mask.getAsFloat32Array();
            if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
                maskCanvas.width = mw;
                maskCanvas.height = mh;
            }
            const img = mg.createImageData(mw, mh);
            for (let i = 0; i < values.length; i++) {
                img.data[i * 4 + 3] = Math.max(0, Math.min(255, (values[i] - 0.15) * 340));
            }
            mg.putImageData(img, 0, 0);
            g.globalCompositeOperation = 'destination-in';
            g.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
            g.globalCompositeOperation = 'source-over';
        }
        result.close?.();
    }

    function drawLoop() {
        if (!playing) return;
        if (video.readyState >= 2) {
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.drawImage(video, 0, 0, canvas.width, canvas.height);
            try {
                if (record.chroma) chromaKey();
                else segmentFrame();
            } catch (err) {
                console.warn('背景を消せませんでした', err);
            }
        }
        if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(drawLoop);
        else requestAnimationFrame(drawLoop);
    }

    function stop() {
        if (!playing) return;
        playing = false;
        video.pause();
        const done = finish;
        finish = null;
        done?.();
    }

    video.addEventListener('ended', stop);

    return {
        setRecord,
        get ready() { return Boolean(record); },
        get playing() { return playing; },
        // 最初から再生し、終わったら resolve する
        async play() {
            if (!record) return;
            stop();
            if (!record.chroma && !segmenter) {
                try {
                    segmenter = await loadSegmenter();
                } catch (err) {
                    console.warn('人物の切り抜きを準備できませんでした（背景ごと再生します）', err);
                }
            }
            video.currentTime = 0;
            video.muted = !record.sound;
            try {
                await video.play();
            } catch {
                // 音つきの自動再生が止められたら、音なしで再生する
                video.muted = true;
                await video.play();
            }
            playing = true;
            drawLoop();
            return new Promise((resolve) => { finish = resolve; });
        },
        stop,
    };
}
