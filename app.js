import { processPhoto, createPhotoRenderer } from './photo-avatar.js?v=10';

// ===== 設定・定数 =====
const STORAGE_KEYS = {
    settings: 'vtuberChat.settings',
    history: 'vtuberChat.history',
    photo: 'vtuberChat.photo', // 写真キャラ（画像と口の位置の JSON）。大きいので設定とは別に保存
};

const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'thinking', 'shy'];

const DEFAULT_PERSONA =
    '明るく元気な新人VTuberの女の子。一人称は「わたし」。視聴者のことを「みんな」や相手の名前で呼ぶ。' +
    'ちょっと天然でリアクションが大きいけど、相談には親身に乗ってくれる。語尾に「〜だよ！」「〜かな？」をよく使う。';

const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'claude-opus-5-5',
    charName: 'ルミ',
    persona: DEFAULT_PERSONA,
    tts: false,
    ttsVoice: '', // voiceURI。空なら自動で選ぶ
    ttsRate: 1.05,
    ttsPitch: 1.1,
    ttsEngine: 'browser', // 'browser' | 'voicevox'
    voicevoxUrl: 'http://127.0.0.1:50021',
    voicevoxSpeaker: 8, // 春日部つむぎ（ノーマル）
    voicevoxSpeakerName: '春日部つむぎ',
    voicevoxStyleName: 'ノーマル',
    appearance: null, // null のときは DEFAULT_APPEARANCE
};

// キャラクターの見た目（AIが設定画面のプロンプトから決める）
const DEFAULT_APPEARANCE = {
    hairStyle: 'twintails',
    hairColor: '#a48af5',
    hairTipColor: '#f4a9d8',
    eyeColor: '#4f6fd8',
    skinColor: '#fff1ea',
    outfitColor: '#34305e',
    collarColor: '#fdfbff',
    accentColor: '#ff6fa5',
    catEars: true,
    earColor: '#fdf7ff',
    hairRibbons: true,
    hairpin: true,
    ahoge: true,
};

// 送信する履歴の上限（往復数ではなくメッセージ数）
const MAX_HISTORY_MESSAGES = 40;

// ===== 状態 =====
let settings = loadJSON(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
settings = { ...DEFAULT_SETTINGS, ...settings };
let history = loadJSON(STORAGE_KEYS.history, []);
let busy = false;

function loadJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : structuredClone(fallback);
    } catch {
        return structuredClone(fallback);
    }
}

function saveJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // 保存できなくても動作は継続する
    }
}

// ===== キャラクター制御 =====
const character = (() => {
    const svg = document.getElementById('character');
    const wrap = document.getElementById('characterWrap');
    const head = document.getElementById('head');
    const pupils = svg.querySelectorAll('.pupil');
    const mouthOpen = svg.querySelector('.mouth-open');
    const wrap0 = document.getElementById('characterWrap');
    const photoMove = document.getElementById('photoMove');
    const photoRenderer = createPhotoRenderer(document.getElementById('photoCanvas'));

    let emotion = 'neutral';
    let speaking = false;
    let mouthLevel = 0;
    let voiceLevel = null; // 音声の音量（0〜1）。null のときは擬似的な口パク
    let talkLevel = 0; // 写真モードで弾ませる量

    // 写真キャラの表情：眉の内側(bi)・外側(bo)（+で下がる）、まぶた(lid)（+で閉じる、-で見開く）
    // L / R は画像の左右の目
    const sym = (bi, bo, lid) => ({ L: { bi, bo, lid }, R: { bi, bo, lid } });
    const PHOTO_EXPR = {
        neutral: sym(0, 0, 0),
        happy: sym(-0.6, -0.5, 0.5),
        sad: sym(-1.6, 0.6, 0.3),
        angry: sym(2.0, -0.9, 0.3),
        surprised: sym(-2.0, -1.7, -0.35),
        thinking: { L: { bi: -1.5, bo: -1.3, lid: 0.05 }, R: { bi: 0.6, bo: 0.4, lid: 0.2 } },
        shy: sym(-0.7, 0, 0.3),
    };
    const photoExpr = { mouth: 0, ...structuredClone(PHOTO_EXPR.neutral) };
    let resetTimer = null;
    const pointer = { x: 0, y: 0 }; // -1〜1 に正規化した視線ターゲット
    let lookAtChat = false;

    // 表情ごとの視線・首の傾き
    const POSE = {
        neutral: { gx: 0, gy: 0, tilt: 0 },
        happy: { gx: 0, gy: 0, tilt: -3 },
        sad: { gx: 0, gy: 4, tilt: 4 },
        angry: { gx: 0, gy: 0, tilt: 0 },
        surprised: { gx: 0, gy: -1, tilt: 0 },
        thinking: { gx: 4, gy: -6, tilt: 6 },
        shy: { gx: -6, gy: 3, tilt: -5 },
    };

    function setEmotion(name, { holdMs = 0 } = {}) {
        if (!EMOTIONS.includes(name)) return;
        clearTimeout(resetTimer);
        if (holdMs > 0) {
            resetTimer = setTimeout(() => setEmotion('neutral'), holdMs);
        }
        if (name === emotion) return;
        svg.classList.remove(`emotion-${emotion}`);
        svg.classList.add(`emotion-${name}`);
        emotion = name;
        if (name !== 'neutral') {
            wrap.classList.remove('react');
            void wrap.offsetWidth; // アニメーションを再スタート
            wrap.classList.add('react');
        }
    }

    function setSpeaking(on) {
        speaking = on;
    }

    // まばたき
    function scheduleBlink() {
        const delay = 2000 + Math.random() * 3500;
        setTimeout(() => {
            svg.classList.add('blink');
            setTimeout(() => {
                svg.classList.remove('blink');
                // たまに二連続まばたき
                if (Math.random() < 0.2) {
                    setTimeout(() => {
                        svg.classList.add('blink');
                        setTimeout(() => svg.classList.remove('blink'), 110);
                    }, 160);
                }
            }, 120);
            scheduleBlink();
        }, delay);
    }

    window.addEventListener('pointermove', (e) => {
        pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    });

    function lookAt(target) {
        lookAtChat = target === 'chat';
    }

    // 毎フレームの更新（揺れ・視線・口パク）
    let t0 = performance.now();
    function frame(now) {
        const t = (now - t0) / 1000;
        const pose = POSE[emotion];

        let tx = pointer.x;
        let ty = pointer.y;
        if (lookAtChat) {
            const chat = document.getElementById('chat').getBoundingClientRect();
            tx = ((chat.left + chat.width / 2) / window.innerWidth) * 2 - 1;
            ty = ((chat.top + chat.height * 0.8) / window.innerHeight) * 2 - 1;
        }

        const gx = clamp(tx * 5 + pose.gx, -7, 7);
        const gy = clamp(ty * 4 + pose.gy, -7, 7);
        pupils.forEach((p) => { p.style.transform = `translate(${gx}px, ${gy}px)`; });

        const sway = Math.sin(t * 0.9) * 1.6;
        const rot = sway + pose.tilt + tx * 3;
        const bob = speaking ? Math.abs(Math.sin(t * 7)) * -2 : 0;
        head.style.transform = `translate(${tx * 4}px, ${ty * 2 + bob}px) rotate(${rot}deg)`;

        // 口パク：発話中はランダムに開閉、驚きは開いたまま
        let target = 0;
        if (voiceLevel !== null) {
            target = voiceLevel;
        } else if (speaking) {
            target = 0.25 + Math.abs(Math.sin(t * 14) * Math.sin(t * 5.3)) * 0.85;
        } else if (emotion === 'surprised') {
            target = 0.9;
        }
        mouthLevel += (target - mouthLevel) * 0.45;
        mouthOpen.style.transform = `scale(${0.75 + mouthLevel * 0.25}, ${Math.max(0.12, mouthLevel)})`;

        // 写真キャラ：イラストの頭と同じように動かし、口の位置が分かれば口パクする
        if (svg.classList.contains('photo-mode')) {
            const k = wrap0.clientWidth / 400; // SVG座標 → 画面のピクセル
            let lift = 0;
            if (photoRenderer.hasFace) {
                // 表情とまばたきに向けて少しずつ近づける（まばたきは速く）
                const target = PHOTO_EXPR[emotion] || PHOTO_EXPR.neutral;
                const blinking = svg.classList.contains('blink');
                for (const side of ['L', 'R']) {
                    const cur = photoExpr[side], tgt = target[side];
                    cur.bi += (tgt.bi - cur.bi) * 0.12;
                    cur.bo += (tgt.bo - cur.bo) * 0.12;
                    cur.lid += ((blinking ? 1 : tgt.lid) - cur.lid) * (blinking ? 0.55 : 0.15);
                }
                // 写真の口はゆっくり開け閉めしたほうが自然に見える
                photoExpr.mouth += (mouthLevel * 0.85 - photoExpr.mouth) * 0.25;
                photoRenderer.update(photoExpr);
            } else {
                // 口の位置が分からない写真は、話している間弾ませる
                talkLevel += ((voiceLevel !== null || speaking ? mouthLevel : 0) - talkLevel) * 0.5;
                lift = talkLevel * 9;
            }
            photoMove.style.transform = `translate(${tx * 4 * k}px, ${(ty * 2 + bob - lift) * k}px) rotate(${rot}deg)`;
        }

        requestAnimationFrame(frame);
    }

    scheduleBlink();
    requestAnimationFrame(frame);

    return {
        setEmotion,
        setSpeaking,
        setVoiceLevel(v) { voiceLevel = v; },
        photo: photoRenderer,
        lookAt,
        get emotion() { return emotion; },
    };
})();

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

// ===== 感情タグのストリーミングパーサー =====
// 応答中の [happy] のようなタグを取り除き、表情イベントに変換する
const TAG_RE = /^\[(neutral|happy|sad|angry|surprised|thinking|shy)\]/;

function createTagParser(onText, onEmotion) {
    let buf = '';
    return {
        push(chunk) {
            buf += chunk;
            while (buf.length) {
                const i = buf.indexOf('[');
                if (i === -1) {
                    onText(buf);
                    buf = '';
                    return;
                }
                if (i > 0) {
                    onText(buf.slice(0, i));
                    buf = buf.slice(i);
                }
                const m = buf.match(TAG_RE);
                if (m) {
                    onEmotion(m[1]);
                    buf = buf.slice(m[0].length);
                    continue;
                }
                // タグの途中で区切れている可能性があるので続きを待つ
                if (!buf.includes(']') && buf.length < 12) return;
                onText('[');
                buf = buf.slice(1);
            }
        },
        flush() {
            if (buf) onText(buf);
            buf = '';
        },
    };
}

function stripTags(text) {
    let out = '';
    let last = null;
    const p = createTagParser((t) => { out += t; }, (e) => { last = e; });
    p.push(text);
    p.flush();
    return { text: out.replace(/^\s+/, ''), emotion: last };
}

// ===== 文字送り（口パク・表情と同期） =====
// 受信したテキストを一定速度で表示し、その間キャラの口を動かす
function createTypewriter(bubble, { onDone } = {}) {
    const queue = []; // {type:'text', ch} | {type:'emotion', name}
    let shown = '';
    let finished = false;
    let timer = null;

    function tick() {
        if (!queue.length) {
            timer = null;
            if (!isSpeaking()) character.setSpeaking(false);
            if (finished) {
                tts.flush();
                onDone?.();
            }
            return;
        }
        const item = queue.shift();
        if (item.type === 'emotion') {
            character.setEmotion(item.name);
        } else {
            character.setSpeaking(true);
            shown += item.ch;
            tts.feed(item.ch);
            bubble.textContent = shown.replace(/^\s+/, '');
            scrollToBottom();
        }
        // 句読点では少し間をとる
        const delay = item.type === 'text' && /[、。！？!?…]/.test(item.ch) ? 140 : 32;
        timer = setTimeout(tick, delay);
    }

    function kick() {
        if (!timer) timer = setTimeout(tick, 0);
    }

    return {
        text(t) {
            for (const ch of t) queue.push({ type: 'text', ch });
            kick();
        },
        emotion(name) {
            queue.push({ type: 'emotion', name });
            kick();
        },
        end() {
            finished = true;
            kick();
        },
    };
}

// ===== 読み上げ =====
// 「端末の声」（Web Speech API）か VOICEVOX で読み上げる。細切れにすると不自然なので、
// 文（。や改行）単位にまとめてから話す。

// 読み上げで変な間や読み方になる記号を整える
function normalizeSpeech(text) {
    return text
        .replace(/[〜～]+/g, 'ー')
        .replace(/…+|\.{2,}/g, '、')
        .replace(/[！!]+/g, '！')
        .replace(/[？?]+[！!]*|[！!]+[？?]+/g, '？')
        .replace(/([、。？！])、+/g, '$1')
        .replace(/^、+/, '')
        .replace(/[wｗ]{2,}/g, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// 端末の声（Web Speech API）
const browserVoice = (() => {
    const supported = 'speechSynthesis' in window;
    let voices = [];

    // 自然に聞こえやすい音声を優先する（端末やブラウザによって入っている音声は異なる）
    const PREFERRED = [/Natural/i, /Nanami/i, /Google/i, /Kyoko/i, /O-?ren/i, /Haruka/i, /Ayumi/i];

    function loadVoices() {
        voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('ja'));
    }
    if (supported) {
        loadVoices();
        speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
    }

    function pickVoice(uri) {
        if (uri) {
            const v = voices.find((x) => x.voiceURI === uri);
            if (v) return v;
        }
        for (const re of PREFERRED) {
            const v = voices.find((x) => re.test(x.name));
            if (v) return v;
        }
        return voices[0] || null;
    }

    function say(text, { rate, pitch, voiceURI }) {
        if (!supported) return;
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        const v = pickVoice(voiceURI);
        if (v) u.voice = v;
        u.rate = rate;
        u.pitch = pitch;
        u.onstart = () => character.setSpeaking(true);
        u.onend = () => { if (!speechSynthesis.speaking) character.setSpeaking(false); };
        speechSynthesis.speak(u);
    }

    return {
        supported,
        get voices() { return voices; },
        pickVoice,
        say,
        isSpeaking: () => supported && speechSynthesis.speaking,
        cancel() { if (supported) speechSynthesis.cancel(); },
    };
})();

// VOICEVOX（PCで起動した VOICEVOX、または同じAPIを持つサーバー）
const voicevox = (() => {
    let ctx = null;
    let analyser = null;
    let samples = null;
    let queue = []; // 合成中の音声（話す順）
    let playing = false;
    let current = null;
    let generation = 0; // cancel() で古い合成結果を捨てるための番号
    let errorShown = false;

    function base(url) {
        return (url || settings.voicevoxUrl).trim().replace(/\/+$/, '');
    }

    // スマホでは、ユーザー操作の中で一度鳴らす準備をしないと音が出ない
    function unlock() {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!ctx) {
            ctx = new AC();
            analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            samples = new Uint8Array(analyser.fftSize);
            analyser.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }

    async function fetchSpeakers(url) {
        const res = await fetch(`${base(url)}/speakers`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function synthesize(text, { url, speaker, rate, pitch }) {
        const root = base(url);
        const q = await fetch(`${root}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: 'POST' });
        if (!q.ok) throw new Error(`audio_query: HTTP ${q.status}`);
        const query = await q.json();
        query.speedScale = rate;
        // VOICEVOX の高さは -0.15〜0.15 の範囲で指定する
        query.pitchScale = clamp((pitch - 1) * 0.15, -0.15, 0.15);
        const res = await fetch(`${root}/synthesis?speaker=${speaker}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(query),
        });
        if (!res.ok) throw new Error(`synthesis: HTTP ${res.status}`);
        const wav = await res.arrayBuffer();
        unlock();
        return ctx.decodeAudioData(wav);
    }

    function reportError(err) {
        console.warn('VOICEVOX での読み上げに失敗しました', err);
        if (errorShown) return;
        errorShown = true;
        addMessage('system', 'VOICEVOX に接続できませんでした。PCで VOICEVOX が起動しているか、⚙ の「読み上げの声」の設定を確認してね。');
    }

    // 音量を測って口の開き具合にする
    function meter() {
        if (!current) {
            character.setVoiceLevel(null);
            return;
        }
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / samples.length);
        character.setVoiceLevel(Math.min(1, rms * 7));
        requestAnimationFrame(meter);
    }

    async function playNext() {
        const gen = generation;
        const item = queue.shift();
        if (!item) {
            playing = false;
            return;
        }
        playing = true;
        const buffer = await item;
        if (gen !== generation) return; // 途中で止められた
        if (!buffer) {
            playNext();
            return;
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(analyser);
        src.onended = () => {
            if (current === src) current = null;
            if (gen === generation) playNext();
        };
        current = src;
        src.start();
        requestAnimationFrame(meter);
    }

    function say(text, options) {
        unlock();
        const job = synthesize(text, options)
            .then((buf) => { errorShown = false; return buf; })
            .catch((err) => { reportError(err); return null; });
        queue.push(job);
        if (!playing) playNext();
    }

    return {
        unlock,
        fetchSpeakers,
        say,
        isSpeaking: () => playing,
        cancel() {
            generation++;
            queue = [];
            playing = false;
            if (current) {
                try { current.stop(); } catch { /* 停止済み */ }
                current = null;
            }
            character.setVoiceLevel(null);
        },
    };
})();

const tts = (() => {
    let buffer = '';

    function currentOptions() {
        return {
            engine: settings.ttsEngine,
            rate: settings.ttsRate,
            pitch: settings.ttsPitch,
            voiceURI: settings.ttsVoice,
            url: settings.voicevoxUrl,
            speaker: settings.voicevoxSpeaker,
        };
    }

    // 読み上げに失敗しても、チャットの表示は止めない
    function say(text, options = currentOptions()) {
        const t = normalizeSpeech(text);
        if (!t) return;
        try {
            if (options.engine === 'voicevox') voicevox.say(t, options);
            else browserVoice.say(t, options);
        } catch (err) {
            console.warn('読み上げに失敗しました', err);
        }
    }

    function flush() {
        const t = buffer;
        buffer = '';
        if (settings.tts && t.trim()) say(t);
    }

    return {
        // 文字送りから1文字ずつ受け取り、文の切れ目でまとめて話す
        feed(ch) {
            buffer += ch;
            const len = buffer.trim().length;
            if (/[。\n]/.test(ch)) flush();
            else if (/[！？!?]/.test(ch) && len >= 20) flush();
            else if (/[、，,]/.test(ch) && len >= 60) flush(); // 長すぎると途中で止まるブラウザがある
        },
        flush,
        // 設定画面の「試しに聞く」用
        preview(text, options) {
            this.cancel();
            say(text, options);
        },
        cancel() {
            buffer = '';
            browserVoice.cancel();
            voicevox.cancel();
        },
    };
})();

function isSpeaking() {
    return settings.tts && (browserVoice.isSpeaking() || voicevox.isSpeaking());
}

// ===== Claude API =====
function buildSystemPrompt() {
    return [
        `あなたは「${settings.charName}」という名前のVTuberとして、配信のチャット欄で視聴者と1対1で会話しています。`,
        '',
        '## キャラクター',
        settings.persona,
        '',
        '## 話し方',
        '- 日本語の話し言葉で、配信中の雑談のように短め（だいたい1〜3文）に返してください。説明を求められたときは必要なだけ長くして構いません。',
        '- 画面に表示され音声でも読み上げられるので、Markdown・箇条書き・コードブロックは使わないでください。',
        '- AIであることを聞かれたら、キャラクターを保ったまま正直に答えてください。',
        '',
        '## 表情タグ',
        'あなたの返答に合わせて、画面のキャラクターの表情が変わります。',
        '返答の先頭に必ず表情タグを1つ付け、話の途中で気持ちが変わったらその位置にも付けてください。',
        '使えるタグ: [neutral] ふつう / [happy] 嬉しい・楽しい / [sad] 悲しい・残念 / [angry] 怒り・ぷんぷん / [surprised] 驚き / [thinking] 考え中・疑問 / [shy] 照れ・恥ずかしい',
        '例: [surprised]えっ、本当に！？[happy]すごいね、おめでとう！',
    ].join('\n');
}

let anthropicModule = null;
async function getClient(apiKey = settings.apiKey) {
    if (!anthropicModule) {
        anthropicModule = await import('@anthropic-ai/sdk');
    }
    const Anthropic = anthropicModule.default;
    return {
        Anthropic,
        client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }),
    };
}

// モデルごとの共通パラメータ
function baseParams(model) {
    const params = { model };
    // 雑談用途なので推論の深さは低めに（Haiku 4.5 は effort 非対応）
    if (model !== 'claude-haiku-4-5') {
        params.output_config = { effort: 'low' };
    }
    // 安全性分類器で断られた場合はサーバー側で別モデルにフォールバックする
    if (model === 'claude-opus-5-5' || model === 'claude-sonnet-5-5') {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
    }
    return params;
}

function toUserFacingError(err, Anthropic) {
    if (err instanceof Anthropic.AuthenticationError) {
        return new UserFacingError('APIキーが正しくないみたい…設定を確認してね。');
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
        return new UserFacingError('このAPIキーではこのモデルを使えないみたい。設定でモデルを変えてみてね。');
    }
    if (err instanceof Anthropic.RateLimitError) {
        return new UserFacingError('アクセスが集中してるみたい。少し待ってからもう一度試してね。');
    }
    if (err instanceof Anthropic.BadRequestError) {
        return new UserFacingError(`リクエストに問題があったみたい: ${err.message}`);
    }
    if (err instanceof Anthropic.APIConnectionError) {
        return new UserFacingError('通信に失敗しちゃった…ネットワークを確認してね。');
    }
    if (err instanceof Anthropic.APIError) {
        return new UserFacingError(`APIエラーが発生しました（${err.status ?? '不明'}）。時間をおいて試してね。`);
    }
    return err;
}

async function streamClaude(messages, writer) {
    const { Anthropic, client } = await getClient();
    const params = {
        ...baseParams(settings.model),
        max_tokens: 8000,
        system: buildSystemPrompt(),
        messages,
    };

    try {
        const stream = client.beta.messages.stream(params);
        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                writer(event.delta.text);
            }
        }
        const final = await stream.finalMessage();
        return { stopReason: final.stop_reason };
    } catch (err) {
        throw toUserFacingError(err, Anthropic);
    }
}

class UserFacingError extends Error {}

// ===== 見た目の変更 =====
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const HAIR_STYLES = ['twintails', 'long', 'short'];

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// a と b を t (0〜1) の割合で混ぜた色
function mix(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// AIの出力に不正な値があっても絵が壊れないよう、項目ごとに既定値で補う
function normalizeAppearance(a) {
    const out = { ...DEFAULT_APPEARANCE };
    if (!a || typeof a !== 'object') return out;
    for (const [key, def] of Object.entries(DEFAULT_APPEARANCE)) {
        const v = a[key];
        if (key === 'hairStyle') {
            if (HAIR_STYLES.includes(v)) out[key] = v;
        } else if (typeof def === 'boolean') {
            if (typeof v === 'boolean') out[key] = v;
        } else if (typeof v === 'string' && HEX_RE.test(v)) {
            out[key] = v.toLowerCase();
        }
    }
    return out;
}

function applyAppearance(raw) {
    const a = normalizeAppearance(raw);
    const svg = document.getElementById('character');
    const setStops = (id, colors) => {
        svg.querySelectorAll(`#${id} stop`).forEach((stop, i) => stop.setAttribute('stop-color', colors[i]));
    };
    const fill = (selector, color) => {
        svg.querySelectorAll(selector).forEach((el) => el.setAttribute('fill', color));
    };
    const show = (selector, visible) => {
        svg.querySelectorAll(selector).forEach((el) => { el.style.display = visible ? '' : 'none'; });
    };

    setStops('hairGrad', [mix(a.hairColor, '#ffffff', 0.45), a.hairColor, a.hairTipColor]);
    setStops('hairFront', [mix(a.hairColor, '#ffffff', 0.4), mix(a.hairColor, '#000000', 0.05)]);
    setStops('hairShade', [mix(a.hairColor, '#000000', 0.18), mix(a.hairTipColor, '#000000', 0.1)]);
    svg.querySelector('.brows').setAttribute('stroke', mix(a.hairColor, '#000000', 0.35));
    setStops('irisGrad', [
        mix(a.eyeColor, '#000000', 0.5),
        a.eyeColor,
        mix(a.eyeColor, '#ffffff', 0.45),
        mix(a.eyeColor, '#ffffff', 0.8),
    ]);
    setStops('skinGrad', [a.skinColor, mix(a.skinColor, '#f0b8a8', 0.15)]);
    fill('.skin', mix(a.skinColor, '#f0b8a8', 0.15));
    fill('.skin-shade', mix(a.skinColor, '#d98a78', 0.3));
    setStops('outfitGrad', [a.outfitColor, mix(a.outfitColor, '#000000', 0.35)]);
    fill('.collar', a.collarColor);
    fill('.accent', a.accentColor);
    fill('.accent-light', mix(a.accentColor, '#ffffff', 0.3));
    svg.querySelectorAll('.accent-stroke').forEach((el) => el.setAttribute('stroke', mix(a.accentColor, '#ffffff', 0.2)));
    fill('.ear-outer', a.earColor);
    fill('.ear-inner', mix(a.accentColor, '#ffffff', 0.5));

    show('.twin-tails', a.hairStyle === 'twintails');
    show('.long-hair', a.hairStyle === 'long');
    show('.cat-ears', a.catEars);
    show('.hair-ribbons', a.hairRibbons);
    show('.hairpin', a.hairpin);
    show('.ahoge', a.ahoge);
}

const APPEARANCE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [...Object.keys(DEFAULT_APPEARANCE), 'summary'],
    properties: {
        hairStyle: { type: 'string', enum: HAIR_STYLES, description: 'twintails=ツインテール, long=ロングヘア, short=ショート/ボブ' },
        hairColor: { type: 'string', description: '髪のメインカラー（#RRGGBB）' },
        hairTipColor: { type: 'string', description: '毛先の色（#RRGGBB）。グラデーションにしないなら hairColor と同じ' },
        eyeColor: { type: 'string', description: '瞳の色（#RRGGBB）' },
        skinColor: { type: 'string', description: '肌の色（#RRGGBB）。明るめの色にする' },
        outfitColor: { type: 'string', description: '服の色（#RRGGBB）' },
        collarColor: { type: 'string', description: 'セーラー襟の色（#RRGGBB）' },
        accentColor: { type: 'string', description: 'リボンなど差し色（#RRGGBB）' },
        catEars: { type: 'boolean', description: '猫耳カチューシャを付けるか' },
        earColor: { type: 'string', description: '猫耳の外側の色（#RRGGBB）' },
        hairRibbons: { type: 'boolean', description: '頭の左右のリボンを付けるか' },
        hairpin: { type: 'boolean', description: '星の髪飾りを付けるか' },
        ahoge: { type: 'boolean', description: 'アホ毛を付けるか' },
        summary: { type: 'string', description: '変更内容をキャラクター本人の口調で一言（日本語、40字以内）' },
    },
};

async function generateAppearance(request, apiKey) {
    const { Anthropic, client } = await getClient(apiKey);
    const current = normalizeAppearance(settings.appearance);
    const params = baseParams(settings.model);
    params.output_config = {
        ...params.output_config,
        format: { type: 'json_schema', schema: APPEARANCE_SCHEMA },
    };
    Object.assign(params, {
        max_tokens: 16000,
        system: [
            'あなたはアニメ風VTuberキャラクターの見た目をデザインします。',
            `キャラクター名は「${settings.charName}」です。`,
            '現在の見た目（JSON）とユーザーの要望をもとに、変更後の見た目をすべての項目について出力してください。',
            '要望で触れられていない項目は現在の値のまま残してください。',
            '色は #RRGGBB 形式で、指定がなければ可愛らしく調和する色を選んでください。',
            '絵で表現できるのは JSON の項目だけです。それ以外の要望（服の形や表情など）は近い項目で表現し、summary で軽く触れてください。',
        ].join('\n'),
        messages: [{
            role: 'user',
            content: `現在の見た目:\n${JSON.stringify(current)}\n\n要望:\n${request}`,
        }],
    });

    let response;
    try {
        response = await client.beta.messages.create(params);
    } catch (err) {
        throw toUserFacingError(err, Anthropic);
    }
    if (response.stop_reason === 'refusal') {
        throw new UserFacingError('その見た目には変更できませんでした。別の言い方で試してね。');
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new UserFacingError('見た目の生成に失敗しました。もう一度試してね。');
    }
    const { summary, ...appearance } = parsed;
    return { appearance: normalizeAppearance(appearance), summary: typeof summary === 'string' ? summary : '' };
}

// ===== デモモード（APIキー未設定時） =====
const DEMO_RULES = [
    { re: /こんにち|こんばん|おはよ|はじめまして|やっほ|hello|hi\b/i, replies: [
        '[happy]やっほー！来てくれてありがとう！今日はどんな一日だった？',
        '[happy]いらっしゃい！ゆっくりしていってね〜！',
    ] },
    { re: /かわい|可愛|好き|すき|素敵/, replies: [
        '[shy]え、えへへ…そんなこと言われたら照れちゃうよ〜！',
        '[surprised]えっ！？[shy]…ありがと。ちょっと嬉しいかも。',
    ] },
    { re: /悲し|つら|辛|疲れ|しんど|落ち込/, replies: [
        '[sad]そっか…それは大変だったね。[neutral]よかったら、何があったか聞かせて？',
        '[sad]無理しすぎないでね。[happy]今日はここでのんびりしていこ！',
    ] },
    { re: /ばか|バカ|嫌い|きらい|うざ/, replies: [
        '[angry]むー！そういうこと言うと怒っちゃうんだからね！',
        '[angry]ぷんぷん！…[sad]でも、何かあったの？',
    ] },
    { re: /[?？]|なに|何|どう|なぜ|なんで/, replies: [
        '[thinking]うーん、なんだろう…ちょっと考えさせて！[happy]APIキーを設定してくれたら、もっとちゃんと答えられるよ！',
        '[thinking]むむ、難しい質問だね…？',
    ] },
    { re: /すご|やった|合格|できた|うれし|嬉し/, replies: [
        '[surprised]えっ、すごい！[happy]おめでとう〜！わたしまで嬉しくなっちゃう！',
    ] },
];
const DEMO_FALLBACK = [
    '[neutral]ふむふむ、なるほどね！[happy]もっと聞かせて！',
    '[happy]そうなんだ〜！楽しそう！',
    '[neutral]今はデモモードだから簡単なお返事しかできないの。[happy]右上の⚙からAPIキーを設定すると、ちゃんとお話しできるよ！',
];

async function streamDemo(userText, writer) {
    const rule = DEMO_RULES.find((r) => r.re.test(userText));
    const pool = rule ? rule.replies : DEMO_FALLBACK;
    const reply = pool[Math.floor(Math.random() * pool.length)];
    await sleep(600);
    // ストリーミング風に少しずつ渡す
    for (let i = 0; i < reply.length; i += 3) {
        writer(reply.slice(i, i + 3));
        await sleep(20);
    }
    return { stopReason: 'end_turn' };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ===== チャットUI =====
const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');

function addMessage(role, text = '') {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    if (role !== 'system') {
        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = role === 'user' ? 'あなた' : settings.charName;
        wrap.appendChild(who);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return bubble;
}

function showTyping(bubble) {
    bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderHistory() {
    messagesEl.innerHTML = '';
    if (!history.length) {
        addMessage('ai', `こんにちは！${settings.charName}だよ。なんでも気軽に話しかけてね！`);
        return;
    }
    for (const m of history) {
        addMessage(m.role === 'user' ? 'user' : 'ai', m.role === 'user' ? m.content : stripTags(m.content).text);
    }
}

async function send(text) {
    if (busy) return;
    busy = true;
    sendBtn.disabled = true;
    tts.cancel();

    addMessage('user', text);
    history.push({ role: 'user', content: text });
    saveJSON(STORAGE_KEYS.history, history);

    const bubble = addMessage('ai');
    showTyping(bubble);
    character.lookAt(null);
    character.setEmotion('thinking');

    let raw = '';
    let started = false;
    let lastEmotion = null;
    let writer;
    const done = new Promise((resolve) => {
        writer = createTypewriter(bubble, { onDone: resolve });
    });
    const parser = createTagParser(
        (t) => {
            if (!started) {
                started = true;
                bubble.textContent = '';
                if (!lastEmotion) writer.emotion('neutral');
            }
            writer.text(t);
        },
        (e) => {
            lastEmotion = e;
            writer.emotion(e);
        },
    );
    const onDelta = (t) => {
        raw += t;
        parser.push(t);
    };

    try {
        const messages = history.slice(-MAX_HISTORY_MESSAGES);
        // 先頭は user メッセージである必要がある
        while (messages.length && messages[0].role !== 'user') messages.shift();

        const result = settings.apiKey
            ? await streamClaude(messages, onDelta)
            : await streamDemo(text, onDelta);

        parser.flush();
        if (result.stopReason === 'refusal') {
            if (!started) bubble.textContent = '';
            writer.emotion('sad');
            writer.text('ごめんね、その話題にはお答えできないの…。別のお話をしよう？');
            raw = '[sad]ごめんね、その話題にはお答えできないの…。';
        } else if (result.stopReason === 'max_tokens') {
            writer.text('…（長くなりすぎちゃった）');
        }
        writer.end();
        await done;

        if (raw.trim()) {
            history.push({ role: 'assistant', content: raw });
        } else {
            history.pop(); // 応答が空なら直前の発言も取り消す
        }
        saveJSON(STORAGE_KEYS.history, history);
    } catch (err) {
        console.error(err);
        bubble.parentElement.remove();
        addMessage('system', err instanceof UserFacingError ? err.message : `エラーが発生しました: ${err.message}`);
        character.setSpeaking(false);
        history.pop();
        saveJSON(STORAGE_KEYS.history, history);
        character.setEmotion('sad', { holdMs: 4000 });
        busy = false;
        sendBtn.disabled = false;
        return;
    }

    // しばらくしたら通常の表情に戻す
    character.setEmotion(character.emotion, { holdMs: 7000 });
    busy = false;
    sendBtn.disabled = false;
    input.focus();
}

composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    if (settings.tts && settings.ttsEngine === 'voicevox') voicevox.unlock();
    input.value = '';
    autoResize();
    send(text);
});

input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        composer.requestSubmit();
    }
});

function autoResize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}
input.addEventListener('input', autoResize);
input.addEventListener('focus', () => { if (!busy) character.lookAt('chat'); });
input.addEventListener('blur', () => character.lookAt(null));

// ===== 読み上げボタン =====
const ttsBtn = document.getElementById('ttsBtn');
const ttsCredit = document.getElementById('ttsCredit');
function updateTtsBtn() {
    ttsBtn.textContent = settings.tts ? '🔊' : '🔇';
    ttsBtn.title = settings.tts ? '読み上げ：オン' : '読み上げ：オフ';
    // VOICEVOX の音声を使うときはクレジット表記が必要
    const useVoicevox = settings.tts && settings.ttsEngine === 'voicevox';
    ttsCredit.hidden = !useVoicevox;
    ttsCredit.textContent = useVoicevox ? `VOICEVOX:${settings.voicevoxSpeakerName}` : '';
}
ttsBtn.addEventListener('click', () => {
    settings.tts = !settings.tts;
    if (!settings.tts) tts.cancel();
    else if (settings.ttsEngine === 'voicevox') voicevox.unlock();
    saveJSON(STORAGE_KEYS.settings, settings);
    updateTtsBtn();
});
updateTtsBtn();

// ===== 設定ダイアログ =====
const dialog = document.getElementById('settingsDialog');
const apiKeyInput = document.getElementById('apiKeyInput');
const modelSelect = document.getElementById('modelSelect');
const charNameInput = document.getElementById('charNameInput');
const personaInput = document.getElementById('personaInput');

// 読み上げの声の設定
const ttsEngineSelect = document.getElementById('ttsEngineSelect');
const browserVoiceBlock = document.getElementById('browserVoiceBlock');
const browserVoiceNote = document.getElementById('browserVoiceNote');
const voicevoxBlock = document.getElementById('voicevoxBlock');
const voicevoxUrlInput = document.getElementById('voicevoxUrlInput');
const voicevoxConnectBtn = document.getElementById('voicevoxConnectBtn');
const voicevoxSpeakerSelect = document.getElementById('voicevoxSpeakerSelect');
const voicevoxStatus = document.getElementById('voicevoxStatus');
const ttsVoiceSelect = document.getElementById('ttsVoiceSelect');
const ttsRateInput = document.getElementById('ttsRateInput');
const ttsPitchInput = document.getElementById('ttsPitchInput');
const ttsRateValue = document.getElementById('ttsRateValue');
const ttsPitchValue = document.getElementById('ttsPitchValue');
if (!browserVoice.supported) {
    ttsEngineSelect.querySelector('option[value="browser"]').textContent = '端末の声（このブラウザでは使えません）';
}

function showEngineBlocks() {
    const vv = ttsEngineSelect.value === 'voicevox';
    voicevoxBlock.hidden = !vv;
    browserVoiceBlock.hidden = vv;
    browserVoiceNote.hidden = vv;
}
ttsEngineSelect.addEventListener('change', showEngineBlocks);

function fillVoiceOptions(selected) {
    ttsVoiceSelect.innerHTML = '';
    const auto = browserVoice.pickVoice('');
    ttsVoiceSelect.add(new Option(`自動（おすすめ）${auto ? `：${auto.name}` : ''}`, ''));
    for (const v of browserVoice.voices) ttsVoiceSelect.add(new Option(v.name, v.voiceURI));
    if (!browserVoice.voices.length) ttsVoiceSelect.add(new Option('日本語の声が見つかりません', '', false, false));
    ttsVoiceSelect.value = browserVoice.voices.some((v) => v.voiceURI === selected) ? selected : '';
}

function speakerOption(speakerName, styleName, id) {
    const o = new Option(`${speakerName}（${styleName}）`, String(id));
    o.dataset.speaker = speakerName;
    o.dataset.style = styleName;
    return o;
}

// 接続前でも、保存してあるキャラクターを選択肢に出しておく
function fillSavedSpeaker() {
    voicevoxSpeakerSelect.innerHTML = '';
    voicevoxSpeakerSelect.add(speakerOption(settings.voicevoxSpeakerName, settings.voicevoxStyleName, settings.voicevoxSpeaker));
}

function setVoicevoxStatus(html, kind = '') {
    voicevoxStatus.innerHTML = html;
    voicevoxStatus.className = `note ${kind}`;
}

const VOICEVOX_HELP =
    'PCで VOICEVOX を起動してから「接続して声を読み込む」を押してください。' +
    '初めてのときは、VOICEVOX のエンジン設定ページ（<code>http://127.0.0.1:50021/setting</code>）を開き、' +
    `「許可するオリジン」に <code>${location.origin}</code> を追加して保存し、VOICEVOX を起動し直してください。` +
    'ブラウザに「ローカルネットワークへのアクセス」の許可を聞かれたら許可してください。スマホ単体では使えません。';

voicevoxConnectBtn.addEventListener('click', async () => {
    voicevox.unlock();
    voicevoxConnectBtn.disabled = true;
    setVoicevoxStatus('接続中…');
    try {
        const speakers = await voicevox.fetchSpeakers(voicevoxUrlInput.value);
        const selected = voicevoxSpeakerSelect.value;
        voicevoxSpeakerSelect.innerHTML = '';
        for (const sp of speakers) {
            for (const st of sp.styles || []) voicevoxSpeakerSelect.add(speakerOption(sp.name, st.name, st.id));
        }
        if ([...voicevoxSpeakerSelect.options].some((o) => o.value === selected)) voicevoxSpeakerSelect.value = selected;
        setVoicevoxStatus(`接続できました！${voicevoxSpeakerSelect.options.length}種類の声から選べます。音声を使うときは画面に「VOICEVOX:キャラクター名」と表示されます。`, 'ok');
    } catch (err) {
        console.warn(err);
        fillSavedSpeaker();
        setVoicevoxStatus(`接続できませんでした。${VOICEVOX_HELP}`, 'error');
    } finally {
        voicevoxConnectBtn.disabled = false;
    }
});

function showRangeValues() {
    ttsRateValue.textContent = Number(ttsRateInput.value).toFixed(2);
    ttsPitchValue.textContent = Number(ttsPitchInput.value).toFixed(2);
}
ttsRateInput.addEventListener('input', showRangeValues);
ttsPitchInput.addEventListener('input', showRangeValues);
if (browserVoice.supported) {
    // 声の一覧は後から読み込まれることがある
    speechSynthesis.addEventListener?.('voiceschanged', () => {
        if (dialog.open) fillVoiceOptions(ttsVoiceSelect.value);
    });
}
document.getElementById('ttsPreviewBtn').addEventListener('click', () => {
    if (ttsEngineSelect.value === 'voicevox') voicevox.unlock();
    tts.preview(`こんにちは！${charNameInput.value.trim() || settings.charName}だよ。今日はどんなお話しようか？`, {
        engine: ttsEngineSelect.value,
        voiceURI: ttsVoiceSelect.value,
        rate: Number(ttsRateInput.value),
        pitch: Number(ttsPitchInput.value),
        url: voicevoxUrlInput.value,
        speaker: Number(voicevoxSpeakerSelect.value),
    });
});

document.getElementById('settingsBtn').addEventListener('click', () => {
    setAppearanceStatus(APPEARANCE_STATUS_DEFAULT);
    setPhotoStatus(PHOTO_STATUS_DEFAULT);
    closeCrop();
    fillVoiceOptions(settings.ttsVoice);
    ttsEngineSelect.value = settings.ttsEngine;
    voicevoxUrlInput.value = settings.voicevoxUrl;
    fillSavedSpeaker();
    setVoicevoxStatus(VOICEVOX_HELP);
    showEngineBlocks();
    ttsRateInput.value = settings.ttsRate;
    ttsPitchInput.value = settings.ttsPitch;
    showRangeValues();
    apiKeyInput.value = settings.apiKey;
    modelSelect.value = settings.model;
    charNameInput.value = settings.charName;
    personaInput.value = settings.persona;
    dialog.showModal();
});

dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    settings.apiKey = apiKeyInput.value.trim();
    settings.model = modelSelect.value;
    settings.charName = charNameInput.value.trim() || DEFAULT_SETTINGS.charName;
    settings.persona = personaInput.value.trim() || DEFAULT_PERSONA;
    settings.ttsVoice = ttsVoiceSelect.value;
    settings.ttsEngine = ttsEngineSelect.value;
    settings.voicevoxUrl = voicevoxUrlInput.value.trim() || DEFAULT_SETTINGS.voicevoxUrl;
    const sp = voicevoxSpeakerSelect.selectedOptions[0];
    if (sp) {
        settings.voicevoxSpeaker = Number(sp.value);
        settings.voicevoxSpeakerName = sp.dataset.speaker;
        settings.voicevoxStyleName = sp.dataset.style;
    }
    settings.ttsRate = Number(ttsRateInput.value);
    settings.ttsPitch = Number(ttsPitchInput.value);
    saveJSON(STORAGE_KEYS.settings, settings);
    updateTtsBtn();
    renderHistory();
});

const appearancePrompt = document.getElementById('appearancePrompt');
const appearanceApplyBtn = document.getElementById('appearanceApplyBtn');
const appearanceResetBtn = document.getElementById('appearanceResetBtn');
const appearanceStatus = document.getElementById('appearanceStatus');

const APPEARANCE_STATUS_DEFAULT = appearanceStatus.textContent;

function setAppearanceStatus(text, isError = false, { notice = false } = {}) {
    appearanceStatus.textContent = text;
    appearanceStatus.classList.toggle('error', isError);
    appearanceStatus.classList.toggle('notice', notice || isError);
    if (notice || isError) {
        // 同じメッセージでも気づけるよう、毎回アニメーションし直す
        appearanceStatus.classList.remove('flash');
        void appearanceStatus.offsetWidth;
        appearanceStatus.classList.add('flash');
        appearanceStatus.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

appearanceApplyBtn.addEventListener('click', async () => {
    // スマホではキーボードを閉じて、結果のメッセージが隠れないようにする
    appearancePrompt.blur();
    const request = appearancePrompt.value.trim();
    // 保存前に入力したキーでも試せるように、入力欄の値を優先する
    const apiKey = apiKeyInput.value.trim() || settings.apiKey;
    if (!request) {
        setAppearanceStatus('どんな見た目にしたいか入力してね。', true);
        return;
    }
    if (!apiKey) {
        setAppearanceStatus('見た目の変更にはAPIキーが必要です。上の欄に入力してね。', true);
        return;
    }
    appearanceApplyBtn.disabled = true;
    appearanceResetBtn.disabled = true;
    setAppearanceStatus('考え中…', false, { notice: true });
    character.setEmotion('thinking');
    try {
        const { appearance, summary } = await generateAppearance(request, apiKey);
        settings.appearance = appearance;
        saveJSON(STORAGE_KEYS.settings, settings);
        applyAppearance(appearance);
        character.setEmotion('happy', { holdMs: 5000 });
        setAppearanceStatus(`変更しました！${summary ? `「${summary}」` : ''}`, false, { notice: true });
        appearancePrompt.value = '';
    } catch (err) {
        console.error(err);
        character.setEmotion('sad', { holdMs: 4000 });
        setAppearanceStatus(err instanceof UserFacingError ? err.message : `エラーが発生しました: ${err.message}`, true);
    } finally {
        appearanceApplyBtn.disabled = false;
        appearanceResetBtn.disabled = false;
    }
});

appearanceResetBtn.addEventListener('click', () => {
    settings.appearance = null;
    saveJSON(STORAGE_KEYS.settings, settings);
    applyAppearance(null);
    setAppearanceStatus('最初の見た目に戻しました。', false, { notice: true });
});

// ===== 写真をキャラにする =====
// data: { image, cutout, face } または null（イラストに戻す）
async function applyPhoto(data) {
    const svg = document.getElementById('character');
    const layer = document.getElementById('photoLayer');
    try {
        await character.photo.load(data);
    } catch (err) {
        console.warn('写真を表示できませんでした', err);
        data = null;
    }
    layer.hidden = !data;
    svg.classList.toggle('photo-mode', Boolean(data));
}


function loadSavedPhoto() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.photo);
        if (!raw) return null;
        // 以前の形式（画像の data URL だけ）にも対応
        return raw.startsWith('data:') ? { image: raw, cutout: false, face: null } : JSON.parse(raw);
    } catch {
        return null;
    }
}

const photoInput = document.getElementById('photoInput');
const photoClearBtn = document.getElementById('photoClearBtn');
const photoStatus = document.getElementById('photoStatus');
const cropArea = document.getElementById('cropArea');
const cropCanvas = document.getElementById('cropCanvas');
const cropZoom = document.getElementById('cropZoom');
const PHOTO_STATUS_DEFAULT = photoStatus.textContent;

function setPhotoStatus(text, isError = false) {
    photoStatus.textContent = text;
    photoStatus.classList.toggle('error', isError);
}

// 切り抜き：写真を枠いっぱいに表示し、ドラッグで移動・スライダーで拡大する
const crop = {
    img: null,
    zoom: 1,
    cx: 0.5, // 枠の中心に来る写真上の位置（0〜1）
    cy: 0.5,
    baseScale() {
        return Math.max(cropCanvas.width / this.img.naturalWidth, cropCanvas.height / this.img.naturalHeight);
    },
    // 枠からはみ出さないように中心位置を制限する
    clampCenter() {
        const s = this.baseScale() * this.zoom;
        const halfW = cropCanvas.width / 2 / (this.img.naturalWidth * s);
        const halfH = cropCanvas.height / 2 / (this.img.naturalHeight * s);
        this.cx = clamp(this.cx, halfW, 1 - halfW);
        this.cy = clamp(this.cy, halfH, 1 - halfH);
    },
    draw(canvas = cropCanvas) {
        const g = canvas.getContext('2d');
        const k = canvas.width / cropCanvas.width;
        const s = this.baseScale() * this.zoom * k;
        const w = this.img.naturalWidth * s;
        const h = this.img.naturalHeight * s;
        g.fillStyle = '#111';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(this.img, canvas.width / 2 - this.cx * w, canvas.height / 2 - this.cy * h, w, h);
    },
};

photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        crop.img = img;
        crop.zoom = 1;
        crop.cx = 0.5;
        crop.cy = 0.4; // 顔は写真の上寄りにあることが多い
        cropZoom.value = 1;
        crop.clampCenter();
        crop.draw();
        cropArea.hidden = false;
        setPhotoStatus('枠の中に顔が入るように調整してね。');
        cropArea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        setPhotoStatus('この写真は読み込めませんでした。別の写真を選んでね。', true);
    };
    img.src = url;
});

cropZoom.addEventListener('input', () => {
    if (!crop.img) return;
    crop.zoom = Number(cropZoom.value);
    crop.clampCenter();
    crop.draw();
});

let dragFrom = null;
cropCanvas.addEventListener('pointerdown', (e) => {
    if (!crop.img) return;
    cropCanvas.setPointerCapture(e.pointerId);
    dragFrom = { x: e.clientX, y: e.clientY, cx: crop.cx, cy: crop.cy };
});
cropCanvas.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    // 画面上の移動量を、写真上の位置（0〜1）の移動量に直す
    const rect = cropCanvas.getBoundingClientRect();
    const s = crop.baseScale() * crop.zoom * (rect.width / cropCanvas.width);
    crop.cx = dragFrom.cx - (e.clientX - dragFrom.x) / (crop.img.naturalWidth * s);
    crop.cy = dragFrom.cy - (e.clientY - dragFrom.y) / (crop.img.naturalHeight * s);
    crop.clampCenter();
    crop.draw();
});
const endDrag = () => { dragFrom = null; };
cropCanvas.addEventListener('pointerup', endDrag);
cropCanvas.addEventListener('pointercancel', endDrag);

function closeCrop() {
    if (crop.img) URL.revokeObjectURL(crop.img.src);
    crop.img = null;
    cropArea.hidden = true;
}

document.getElementById('cropCancelBtn').addEventListener('click', () => {
    closeCrop();
    setPhotoStatus(PHOTO_STATUS_DEFAULT);
});

const cropApplyBtn = document.getElementById('cropApplyBtn');
const cutoutCheck = document.getElementById('cutoutCheck');

cropApplyBtn.addEventListener('click', async () => {
    if (!crop.img) return;
    const out = document.createElement('canvas');
    out.width = cropCanvas.width;
    out.height = cropCanvas.height;
    crop.draw(out);

    cropApplyBtn.disabled = true;
    setPhotoStatus('人物と口の位置を探しています…（初回は準備に少し時間がかかります）');
    character.setEmotion('thinking');
    let data;
    let note = '';
    try {
        data = await processPhoto(out, { cutout: cutoutCheck.checked });
        if (!data.face) note = '顔が見つからなかったので、口パクの代わりに弾んで話します。';
    } catch (err) {
        console.warn('写真の処理に失敗しました', err);
        // 切り抜きの準備ができなくても、写真はそのまま使えるようにする
        data = { image: out.toDataURL('image/jpeg', 0.85), cutout: false, face: null };
        note = '切り抜きと口パクの準備ができなかったので、写真をそのまま使います（通信状況を確認してね）。';
    } finally {
        cropApplyBtn.disabled = false;
    }

    let saved = true;
    try {
        localStorage.setItem(STORAGE_KEYS.photo, JSON.stringify(data));
    } catch {
        saved = false;
    }
    await applyPhoto(data);
    closeCrop();
    character.setEmotion('happy', { holdMs: 4000 });
    setPhotoStatus(
        (saved ? '写真をキャラにしました！「イラストに戻す」でいつでも戻せます。' : '写真を保存できませんでした（ブラウザの保存容量が足りないかも）。今回だけ表示します。') +
            (note ? ` ${note}` : ''),
        !saved,
    );
});

photoClearBtn.addEventListener('click', () => {
    try { localStorage.removeItem(STORAGE_KEYS.photo); } catch { /* 無視 */ }
    applyPhoto(null);
    closeCrop();
    setPhotoStatus('イラストに戻しました。');
});

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    if (!confirm('会話履歴をすべて削除しますか？')) return;
    history = [];
    saveJSON(STORAGE_KEYS.history, history);
    dialog.close();
    renderHistory();
    character.setEmotion('neutral');
});

// ===== スマホのキーボード対策 =====
// キーボード表示で見える範囲が狭くなっても、キャラの顔とチャット欄が両方収まるようにする
(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const stage = document.getElementById('stage');
    let fullHeight = vv.height;

    function update() {
        fullHeight = Math.max(fullHeight, vv.height);
        document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
        document.body.classList.toggle('kb-open', vv.height < fullHeight * 0.75);
        // iOS などでページ自体がずらされた場合も、見えている位置に合わせる
        stage.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
        scrollToBottom();
    }

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('orientationchange', () => {
        fullHeight = 0;
        setTimeout(update, 300);
    });
    update();
})();

// ===== 起動 =====
applyAppearance(settings.appearance);
applyPhoto(loadSavedPhoto());
renderHistory();
if (!settings.apiKey) {
    addMessage('system', 'デモモードで動作中です。右上の ⚙ から Anthropic API キーを設定すると AI と会話できます。');
}
