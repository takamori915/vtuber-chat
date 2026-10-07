// ===== 設定・定数 =====
const STORAGE_KEYS = {
    settings: 'vtuberChat.settings',
    history: 'vtuberChat.history',
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

    let emotion = 'neutral';
    let speaking = false;
    let mouthLevel = 0;
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
        if (speaking) {
            target = 0.25 + Math.abs(Math.sin(t * 14) * Math.sin(t * 5.3)) * 0.85;
        } else if (emotion === 'surprised') {
            target = 0.9;
        }
        mouthLevel += (target - mouthLevel) * 0.45;
        mouthOpen.style.transform = `scale(${0.75 + mouthLevel * 0.25}, ${Math.max(0.12, mouthLevel)})`;

        requestAnimationFrame(frame);
    }

    scheduleBlink();
    requestAnimationFrame(frame);

    return {
        setEmotion,
        setSpeaking,
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
    let speech = '';

    function tick() {
        if (!queue.length) {
            timer = null;
            if (!isSpeaking()) character.setSpeaking(false);
            if (finished) {
                flushSpeech();
                onDone?.();
            }
            return;
        }
        const item = queue.shift();
        if (item.type === 'emotion') {
            flushSpeech();
            character.setEmotion(item.name);
        } else {
            character.setSpeaking(true);
            shown += item.ch;
            speech += item.ch;
            bubble.textContent = shown.replace(/^\s+/, '');
            scrollToBottom();
            if (/[。！？!?\n]/.test(item.ch)) flushSpeech();
        }
        // 句読点では少し間をとる
        const delay = item.type === 'text' && /[、。！？!?…]/.test(item.ch) ? 140 : 32;
        timer = setTimeout(tick, delay);
    }

    function flushSpeech() {
        const s = speech.trim();
        speech = '';
        if (s) tts.speak(s);
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

// ===== 読み上げ（Web Speech API） =====
const tts = (() => {
    const supported = 'speechSynthesis' in window;
    let voice = null;

    function pickVoice() {
        const voices = speechSynthesis.getVoices();
        voice = voices.find((v) => v.lang === 'ja-JP' && /female|Kyoko|Nanami|Haruka/i.test(v.name))
            || voices.find((v) => v.lang.startsWith('ja')) || null;
    }
    if (supported) {
        pickVoice();
        speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
    }

    return {
        supported,
        speak(text) {
            if (!supported || !settings.tts) return;
            const u = new SpeechSynthesisUtterance(text);
            u.lang = 'ja-JP';
            if (voice) u.voice = voice;
            u.pitch = 1.35;
            u.rate = 1.1;
            u.onstart = () => character.setSpeaking(true);
            u.onend = () => { if (!speechSynthesis.speaking) character.setSpeaking(false); };
            speechSynthesis.speak(u);
        },
        cancel() {
            if (supported) speechSynthesis.cancel();
        },
    };
})();

function isSpeaking() {
    return tts.supported && settings.tts && speechSynthesis.speaking;
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
async function getClient() {
    if (!anthropicModule) {
        anthropicModule = await import('@anthropic-ai/sdk');
    }
    const Anthropic = anthropicModule.default;
    return {
        Anthropic,
        client: new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true }),
    };
}

async function streamClaude(messages, writer) {
    const { Anthropic, client } = await getClient();
    const model = settings.model;

    const params = {
        model,
        max_tokens: 8000,
        system: buildSystemPrompt(),
        messages,
    };
    // 雑談用途なので推論の深さは低めに（Haiku 4.5 は effort 非対応）
    if (model !== 'claude-haiku-4-5') {
        params.output_config = { effort: 'low' };
    }
    // 安全性分類器で断られた場合はサーバー側で別モデルにフォールバックする
    if (model === 'claude-opus-5-5' || model === 'claude-sonnet-5-5') {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
    }

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
        if (err instanceof Anthropic.AuthenticationError) {
            throw new UserFacingError('APIキーが正しくないみたい…設定を確認してね。');
        }
        if (err instanceof Anthropic.PermissionDeniedError) {
            throw new UserFacingError('このAPIキーではこのモデルを使えないみたい。設定でモデルを変えてみてね。');
        }
        if (err instanceof Anthropic.RateLimitError) {
            throw new UserFacingError('アクセスが集中してるみたい。少し待ってからもう一度話しかけてね。');
        }
        if (err instanceof Anthropic.BadRequestError) {
            throw new UserFacingError(`リクエストに問題があったみたい: ${err.message}`);
        }
        if (err instanceof Anthropic.APIConnectionError) {
            throw new UserFacingError('通信に失敗しちゃった…ネットワークを確認してね。');
        }
        if (err instanceof Anthropic.APIError) {
            throw new UserFacingError(`APIエラーが発生しました（${err.status ?? '不明'}）。時間をおいて試してね。`);
        }
        throw err;
    }
}

class UserFacingError extends Error {}

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
function updateTtsBtn() {
    ttsBtn.textContent = settings.tts ? '🔊' : '🔇';
    ttsBtn.title = settings.tts ? '読み上げ：オン' : '読み上げ：オフ';
}
if (!tts.supported) ttsBtn.hidden = true;
ttsBtn.addEventListener('click', () => {
    settings.tts = !settings.tts;
    if (!settings.tts) tts.cancel();
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

document.getElementById('settingsBtn').addEventListener('click', () => {
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
    saveJSON(STORAGE_KEYS.settings, settings);
    renderHistory();
});

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    if (!confirm('会話履歴をすべて削除しますか？')) return;
    history = [];
    saveJSON(STORAGE_KEYS.history, history);
    dialog.close();
    renderHistory();
    character.setEmotion('neutral');
});

// ===== 起動 =====
renderHistory();
if (!settings.apiKey) {
    addMessage('system', 'デモモードで動作中です。右上の ⚙ から Anthropic API キーを設定すると AI と会話できます。');
}
