// 全身写真の手足を動かす（骨組みに沿って写真を曲げる）
//
// 1. 写真の人物部分を細かい網目（三角形）に分ける
// 2. 各頂点が「胴体・上腕・前腕・太もも・すね」のどの骨にどれだけ付いていくか（重み）を決める
// 3. 骨を回すと、頂点が重みに応じて動き、写真が一緒に曲がる
// 描画は WebGL（GPU）で行う。表情や口パクを描いた写真の canvas をそのまま貼り付ける。

const GRID = 8; // 網目の細かさ（ピクセル）

// 2Dの変換 [a, b, c, d, e, f]：x' = a*x + c*y + e, y' = b*x + d*y + f
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

// 点 (px, py) を中心に deg 度回す（画面の座標では＋が時計回り）
function rotateAround(px, py, deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py];
}

// 点と線分の距離
function segmentDistance(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

// 点が四角形（凸）の中にあれば 0、外なら辺までの距離
function quadDistance(px, py, q) {
    let inside = true;
    let min = Infinity;
    for (let i = 0; i < 4; i++) {
        const a = q[i], b = q[(i + 1) % 4];
        const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
        if (cross < 0) inside = false;
        min = Math.min(min, segmentDistance(px, py, a, b));
    }
    return inside ? 0 : min;
}

// MediaPipe Pose の番号（左右は写っている人から見た向き）
const POSE = {
    leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
    leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
};

// 姿勢の検出結果から、保存用に必要な点だけを取り出す（0〜1の座標と見えている度合い）
export function extractPose(landmarks) {
    if (!landmarks) return null;
    const out = {};
    for (const [k, i] of Object.entries(POSE)) {
        const p = landmarks[i];
        if (!p) return null;
        out[k] = { x: p.x, y: p.y, v: p.visibility ?? 1 };
    }
    return out;
}

export function createBodyRig(glCanvas) {
    const W = glCanvas.width, H = glCanvas.height;
    const gl = glCanvas.getContext('webgl', { premultipliedAlpha: true, alpha: true });
    let program = null;
    let tex = null;
    let rig = null;
    let posBuf = null, uvBuf = null, idxBuf = null;

    function setupGL() {
        if (!gl || program) return Boolean(gl);
        const vs = `
            attribute vec2 aPos; attribute vec2 aUv; varying vec2 vUv;
            uniform vec2 uSize;
            void main() {
                vUv = aUv;
                vec2 p = aPos / uSize * 2.0 - 1.0;
                gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
            }`;
        const fs = `
            precision mediump float; varying vec2 vUv; uniform sampler2D uTex;
            void main() { gl_FragColor = texture2D(uTex, vUv); }`;
        const compile = (type, srcText) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, srcText);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
            return sh;
        };
        program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        posBuf = gl.createBuffer();
        uvBuf = gl.createBuffer();
        idxBuf = gl.createBuffer();
        return true;
    }

    // 骨組みと網目を作る
    function build(alpha, pose) {
        const alphaAt = (x, y) => {
            const ix = Math.min(W - 1, Math.max(0, Math.round(x))), iy = Math.min(H - 1, Math.max(0, Math.round(y)));
            return alpha[iy * W + ix];
        };
        const P = (k) => ({ x: pose[k].x * W, y: pose[k].y * H, v: pose[k].v });
        const seen = (...ps) => ps.every((p) => p.v > 0.5 && p.x > -W * 0.05 && p.x < W * 1.05 && p.y > -H * 0.05 && p.y < H * 1.05);

        // 画像の左右で呼ぶ（L = 画像の左側）
        let sh = [P('leftShoulder'), P('rightShoulder')];
        let el = [P('leftElbow'), P('rightElbow')];
        let wr = [P('leftWrist'), P('rightWrist')];
        let hp = [P('leftHip'), P('rightHip')];
        let kn = [P('leftKnee'), P('rightKnee')];
        let an = [P('leftAnkle'), P('rightAnkle')];
        if (sh[0].x > sh[1].x) [sh, el, wr, hp, kn, an] = [sh, el, wr, hp, kn, an].map(([a, b]) => [b, a]);
        if (!seen(sh[0], sh[1])) return null;
        // 腰まで写っていない写真（顔・上半身のアップ）は手足の位置があいまいなので、体全体の動きだけにする
        const hipsSeen = seen(hp[0], hp[1]);
        if (!hipsSeen) return null;
        const shoulderW = Math.hypot(sh[1].x - sh[0].x, sh[1].y - sh[0].y);
        if (shoulderW < 12) return null;
        const hipC = { x: (hp[0].x + hp[1].x) / 2, y: (hp[0].y + hp[1].y) / 2 };
        // 胴体：肩と腰の四角形を少し広げたもの（時計回り）。関節は体の内側にあるので、脇腹まで入るように広げる
        const grow = shoulderW * 0.12;
        const torsoQuad = [
            { x: sh[0].x - grow, y: sh[0].y }, { x: sh[1].x + grow, y: sh[1].y },
            { x: hp[1].x + grow, y: hp[1].y }, { x: hp[0].x - grow, y: hp[0].y },
        ];

        // 腕が体や頭にくっついている（服を持つ、頭に手を当てる等）と、回したときに服や頭まで伸びてしまう。
        // ひじと手首（と前腕の中ほど）が胴体と頭から十分離れている腕だけ動かす
        const headC = { x: (sh[0].x + sh[1].x) / 2, y: Math.min(sh[0].y, sh[1].y) - shoulderW * 0.9 };
        const headR = shoulderW * 0.75;
        // 腕と体の間に、背景が見えるすき間があるか（腕から体の中心へ向かって調べる）
        const centerX = (sh[0].x + sh[1].x) / 2;
        const hasGap = (q) => {
            const dir = Math.sign(centerX - q.x);
            for (let x = q.x; Math.abs(x - centerX) > shoulderW * 0.1; x += dir * 2) {
                if (alphaAt(x, q.y) < 40) return true;
            }
            return false;
        };
        const armIsFree = (e, w) => {
            const mid = { x: (e.x + w.x) / 2, y: (e.y + w.y) / 2 };
            const away = [e, mid, w].every((q) => quadDistance(q.x, q.y, torsoQuad) > shoulderW * 0.15 && Math.hypot(q.x - headC.x, q.y - headC.y) > headR);
            return away && hasGap(mid) && hasGap(w);
        };

        // 骨：{ name, a: 付け根, b: 先, parent, side(+1: 画像の左, -1: 右) }
        const bones = [{ name: 'torso', a: hipC, b: { x: (sh[0].x + sh[1].x) / 2, y: (sh[0].y + sh[1].y) / 2 }, parent: null }];
        for (const i of [0, 1]) {
            const side = i === 0 ? 1 : -1;
            const key = i === 0 ? 'L' : 'R';
            if (seen(el[i], wr[i]) && armIsFree(el[i], wr[i])) {
                bones.push({ name: `upperArm${key}`, a: sh[i], b: el[i], parent: 'torso', side });
                bones.push({ name: `foreArm${key}`, a: el[i], b: wr[i], parent: `upperArm${key}`, side, tip: true });
            }
            if (hipsSeen && seen(kn[i], an[i])) {
                bones.push({ name: `thigh${key}`, a: hp[i], b: kn[i], parent: null, side });
                bones.push({ name: `shin${key}`, a: kn[i], b: an[i], parent: `thigh${key}`, side, tip: true });
            }
        }
        if (bones.length === 1) return null; // 手も足も見えない写真は全体の動きだけにする

        // 網目：人物部分（不透明なところ）だけ
        const cols = Math.ceil(W / GRID) + 1, rows = Math.ceil(H / GRID) + 1;
        const vid = new Int32Array(cols * rows).fill(-1);
        const pos = [], uv = [], idx = [];
        const vertex = (c, r) => {
            const k = r * cols + c;
            if (vid[k] < 0) {
                vid[k] = pos.length / 2;
                const x = Math.min(W, c * GRID), y = Math.min(H, r * GRID);
                pos.push(x, y);
                uv.push(x / W, y / H);
            }
            return vid[k];
        };
        for (let r = 0; r < rows - 1; r++) {
            for (let c = 0; c < cols - 1; c++) {
                // 輪郭がギザギザにならないよう、少しでも人物にかかるマスは含める（透明部分は画像側で透ける）
                const x0 = c * GRID, y0 = r * GRID, x1 = x0 + GRID, y1 = y0 + GRID, xm = x0 + GRID / 2, ym = y0 + GRID / 2;
                if (Math.max(alphaAt(xm, ym), alphaAt(x0, y0), alphaAt(x1, y0), alphaAt(x0, y1), alphaAt(x1, y1)) < 8) continue;
                const a = vertex(c, r), b = vertex(c + 1, r), d = vertex(c, r + 1), e = vertex(c + 1, r + 1);
                idx.push(a, b, d, b, e, d);
            }
        }
        if (!idx.length) return null;

        // 重み：骨に近いほど強く付いていく。胴体の中は胴体だけ
        const nV = pos.length / 2;
        const boneIdx = new Uint8Array(nV * 2);
        const boneW = new Float32Array(nV * 2);
        const reach = shoulderW * 0.3;
        for (let v = 0; v < nV; v++) {
            const x = pos[v * 2], y = pos[v * 2 + 1];
            const scores = bones.map((bone) => {
                let d;
                if (bone.name === 'torso') {
                    d = quadDistance(x, y, torsoQuad);
                    // 肩より上（頭）は胴体と一緒に動かす
                    if (y < Math.min(sh[0].y, sh[1].y) && x > sh[0].x - reach && x < sh[1].x + reach) d = Math.min(d, reach * 0.3);
                } else {
                    d = segmentDistance(x, y, bone.a, bone.b);
                    // 手先・足先は骨の先より外側の肉（手のひら、足）も付いていくように
                    if (bone.tip) d = Math.min(d, segmentDistance(x, y, bone.b, { x: bone.b.x + (bone.b.x - bone.a.x) * 0.5, y: bone.b.y + (bone.b.y - bone.a.y) * 0.5 }));
                }
                // 腕・脚は、その太さくらいの範囲だけ引っぱる（腰の横の服などを巻き込まない）
                if (bone.name !== 'torso') {
                    const limbR = shoulderW * (bone.name.startsWith('thigh') || bone.name.startsWith('shin') ? 0.32 : 0.32);
                    if (d > limbR) return 0;
                }
                return 1 / Math.pow(Math.max(d, 1) / reach + 0.05, 6);
            });
            // どの手足からも遠い点は胴体に付ける
            if (scores.every((sc, i) => i === 0 || sc === 0)) scores[0] = Math.max(scores[0], 1e-6);
            // 上位2本の骨だけ使う
            const order = scores.map((s, i) => i).sort((p, q) => scores[q] - scores[p]);
            const s0 = scores[order[0]], s1 = scores[order[1]] || 0;
            boneIdx[v * 2] = order[0];
            boneIdx[v * 2 + 1] = order[1] ?? order[0];
            boneW[v * 2] = s0 / (s0 + s1);
            boneW[v * 2 + 1] = s1 / (s0 + s1);
        }

        // 腕と胴体（脚どうし）のすき間にまたがる三角形を除く。
        // 違う骨に付いた頂点をつなぐ三角形の中心が透明なら、それは体の外（すき間）なので、
        // 残すと手足を動かしたときにマントのように伸びてしまう
        // 左右の脚どうしの境目（股の下）は切り離す。つないだままだと、脚を動かしたときにゴムのように伸びる
        // （体にくっついている腕は、そもそも動かさない）
        const legOf = (i) => {
            const n = bones[i].name;
            return n.startsWith('thigh') || n.startsWith('shin') ? n.slice(-1) : null;
        };
        function isSeam(set) {
            const legs = new Set([...set].map(legOf).filter(Boolean));
            return legs.size > 1;
        }

        function keepTris(list) {
            const out = [];
            for (let t = 0; t < list.length; t += 3) {
                const a = list[t], b = list[t + 1], c = list[t + 2];
                const ba = boneIdx[a * 2], bb = boneIdx[b * 2], bc = boneIdx[c * 2];
                if (ba !== bb || bb !== bc) {
                    const cx = (pos[a * 2] + pos[b * 2] + pos[c * 2]) / 3;
                    const cy = (pos[a * 2 + 1] + pos[b * 2 + 1] + pos[c * 2 + 1]) / 3;
                    if (alphaAt(cx, cy) < 40) continue;
                    if (isSeam(new Set([ba, bb, bc]))) continue;
                }
                out.push(a, b, c);
            }
            return out;
        }

        return {
            bones,
            hipC,
            rest: new Float32Array(pos),
            uv: new Float32Array(uv),
            idx: new Uint16Array(keepTris(idx)),
            boneIdx,
            boneW,
            out: new Float32Array(pos.length),
        };
    }

    return {
        // data: { image, pose }（写真の処理結果）
        async load(data) {
            rig = null;
            if (!data?.pose || !data.cutout) return;
            try {
                if (!setupGL()) return;
                const img = new Image();
                img.src = data.image;
                await img.decode();
                const c = document.createElement('canvas');
                c.width = W;
                c.height = H;
                const g = c.getContext('2d');
                g.drawImage(img, 0, 0, W, H);
                const px = g.getImageData(0, 0, W, H).data;
                const alpha = new Uint8Array(W * H);
                for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
                rig = build(alpha, data.pose);
                if (!rig) return;
                gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
                gl.bufferData(gl.ARRAY_BUFFER, rig.uv, gl.STATIC_DRAW);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, rig.idx, gl.STATIC_DRAW);
            } catch (err) {
                console.warn('手足を動かす準備ができませんでした', err);
                rig = null;
            }
        },
        get active() { return Boolean(rig); },
        get limbs() { return rig ? rig.bones.map((b) => b.name) : []; },

        // 骨の角度（度）を受け取り、source（表情を描いた写真の canvas）を曲げて描く
        // angles: { torso, upperArmL, foreArmL, upperArmR, foreArmR, thighL, shinL, thighR, shinR }
        // 腕・脚の角度は「外側・上へ」が＋（左右の向きはこちらで合わせる）
        render(source, angles) {
            if (!rig) return;
            const mats = {};
            for (const bone of rig.bones) {
                const parent = bone.parent ? mats[bone.parent] : IDENTITY;
                const deg = (angles[bone.name] || 0) * (bone.side ?? 1);
                mats[bone.name] = multiply(parent, rotateAround(bone.a.x, bone.a.y, deg));
            }
            const list = rig.bones.map((b) => mats[b.name]);
            const { rest, out, boneIdx, boneW } = rig;
            for (let v = 0, n = rest.length / 2; v < n; v++) {
                const x = rest[v * 2], y = rest[v * 2 + 1];
                const m0 = list[boneIdx[v * 2]], m1 = list[boneIdx[v * 2 + 1]];
                const w0 = boneW[v * 2], w1 = boneW[v * 2 + 1];
                out[v * 2] = w0 * (m0[0] * x + m0[2] * y + m0[4]) + w1 * (m1[0] * x + m1[2] * y + m1[4]);
                out[v * 2 + 1] = w0 * (m0[1] * x + m0[3] * y + m0[5]) + w1 * (m1[1] * x + m1[3] * y + m1[5]);
            }

            gl.viewport(0, 0, W, H);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.useProgram(program);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.uniform2f(gl.getUniformLocation(program, 'uSize'), W, H);

            const aPos = gl.getAttribLocation(program, 'aPos');
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
            const aUv = gl.getAttribLocation(program, 'aUv');
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
            gl.enableVertexAttribArray(aUv);
            gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
            gl.drawElements(gl.TRIANGLES, rig.idx.length, gl.UNSIGNED_SHORT, 0);
        },
    };
}

// 踊りの手足の動き（拍 b に対する、写真の姿勢からの回転角）。体全体の動き（app.js の danceTransform）と同じ拍で動く。
// 写真を曲げているので、大きく回すと不自然に伸びる。腕は最大60度、脚は小さくひざを曲げる程度にとどめる
export function danceAngles(b, env) {
    const part = Math.floor(b / 8) % 3;
    const s = Math.sin(b * Math.PI);
    const a = {};
    if (part === 0) {
        // 左右交互に腕を振る
        a.upperArmL = 20 + 25 * s;
        a.upperArmR = 20 - 25 * s;
        a.foreArmL = 10 + 10 * Math.abs(s);
        a.foreArmR = 10 + 10 * Math.abs(s);
        a.thighL = 4 * Math.max(0, s);
        a.thighR = 4 * Math.max(0, -s);
        a.shinL = -8 * Math.max(0, s);
        a.shinR = -8 * Math.max(0, -s);
        a.torso = 3 * Math.sin((b * Math.PI) / 2);
    } else if (part === 1) {
        // 両手を広げてフリフリ
        const w = Math.sin(b * Math.PI * 2);
        a.upperArmL = 50 + 10 * w;
        a.upperArmR = 50 - 10 * w;
        a.foreArmL = 10 + 10 * w;
        a.foreArmR = 10 - 10 * w;
        a.thighL = a.thighR = 4 * Math.abs(s);
        a.shinL = a.shinR = -8 * Math.abs(s);
        a.torso = 4 * Math.sin(b * Math.PI);
    } else {
        // ひじを曲げてリズムを取る（回転しながら）
        a.upperArmL = a.upperArmR = 30;
        a.foreArmL = a.foreArmR = 20 + 25 * Math.abs(s);
        a.thighL = a.thighR = 5 * Math.abs(s);
        a.shinL = a.shinR = -10 * Math.abs(s);
        a.torso = 0;
    }
    for (const k of Object.keys(a)) a[k] *= env;
    return a;
}
