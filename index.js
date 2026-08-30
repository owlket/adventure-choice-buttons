const MODULE_NAME = 'adventure-choice-buttons';
/** Build marker shown in logs; also used as the stylesheet cache-buster (same trick as adventure-launcher — mobile browsers hold stale CSS for a long time). */
const BUILD_ID = '1.5.0';
const STYLESHEET_LINK_ID = 'adventure-choice-buttons-css';
const BAR_ID = 'cob-bar';
const PREVIEW_ID = 'cob-preview';
const LONG_PRESS_MS = 500;
const MAX_OPTIONS = 12;
/** How many messages back to look for a choice-bearing message past media-only replies (generated images). */
const MAX_MEDIA_LOOKBACK = 8;

const defaultSettings = {
    enabled: true,
    /** Hide the core message bar while choice buttons are visible. */
    hideInput: true,
    /** Template for the user message sent when an option is tapped. Placeholders: {{number}}, {{label}}, {{text}}. */
    sendTemplate: '{{number}}. {{label}}',
    /** Minimum numbered options required before the bar appears. */
    minOptions: 2,
    /** Long-press an option button to preview its full text without sending. */
    longPressPreview: true,
    /** Show the option label next to its number (number-only when off). */
    showLabels: true,
    /** Add a keyboard button that manually un-hides the message bar. */
    showKeyboardButton: false,
    /** Number keys (1-9, 0 = 10) trigger the matching option while the bar is visible. */
    keyboardSelection: true,
    /** Optional regex marking extra trailing status lines to ignore after the list (e.g. "^理智 .*回合"). */
    trailingStatusPattern: '',
};

/** @type {object|null} */
let eventSource = null;
/** @type {object|null} */
let event_types = null;
/** @type {Function|null} */
let Generate = null;
/** @type {Function|null} */
let stopGeneration = null;
/** @type {Function|null} */
let saveSettingsDebounced = null;
/** @type {Function|null} */
let getContextFn = null;
/** @type {object|null} */
let extensionSettingsStore = null;
/** @type {object} */
let toastr = { success: () => {}, error: () => {}, warning: () => {}, info: () => {} };

/** @type {Array<{number: number, label: string, text: string}>} Current parsed options. */
let currentOptions = [];
/** @type {boolean} True while a (non-quiet) generation is running. */
let generating = false;
/** @type {boolean} Session-level override set by the optional keyboard button: forces the input visible. */
let manualInputVisible = false;
/** @type {number|null} Debounce timer for refresh(). */
let refreshTimer = null;
/** @type {HTMLElement|null} */
let barEl = null;

/* ------------------------------------------------------------------------- */
/* Stylesheet (cache-busted, same hardening as adventure-launcher)           */
/* ------------------------------------------------------------------------- */

function ensureStylesheet() {
    try {
        const href = new URL(`style.css?v=${BUILD_ID}`, import.meta.url).href;
        let link = document.getElementById(STYLESHEET_LINK_ID);
        if (!link) {
            link = document.createElement('link');
            link.id = STYLESHEET_LINK_ID;
            link.rel = 'stylesheet';
            link.href = href;
            document.head.appendChild(link);
        } else if (link.href !== href) {
            link.href = href;
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to inject cache-busted stylesheet:`, err);
    }
}

/* ------------------------------------------------------------------------- */
/* Core API resolution (path-agnostic, mirrors adventure-launcher)           */
/* ------------------------------------------------------------------------- */

function modulePath(scriptRelative, thirdPartyRelative) {
    const isThirdParty = import.meta.url.includes('/third-party/');
    return new URL(isThirdParty ? thirdPartyRelative : scriptRelative, import.meta.url).href;
}

async function loadScriptApi() {
    try {
        const scriptApi = await import(modulePath('../../../script.js', '../../../../script.js'));
        eventSource = scriptApi.eventSource || window.eventSource;
        event_types = scriptApi.event_types || window.event_types;
        Generate = scriptApi.Generate || window.Generate || null;
        stopGeneration = scriptApi.stopGeneration || window.stopGeneration || null;
        saveSettingsDebounced = scriptApi.saveSettingsDebounced || window.saveSettingsDebounced || null;
    } catch (err) {
        console.warn(`[${MODULE_NAME}] script.js import failed, falling back to window globals.`, err);
        eventSource = window.eventSource;
        event_types = window.event_types;
        Generate = window.Generate || null;
        stopGeneration = window.stopGeneration || null;
        saveSettingsDebounced = window.saveSettingsDebounced || null;
    }

    try {
        const extensionsApi = await import(modulePath('../../extensions.js', '../../../extensions.js'));
        extensionSettingsStore = extensionsApi.extension_settings || window.extension_settings || null;
        getContextFn = extensionsApi.getContext || null;
    } catch (err) {
        console.warn(`[${MODULE_NAME}] extensions.js import failed, falling back to globals.`, err);
        extensionSettingsStore = window.extension_settings || null;
    }

    if (!getContextFn && window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        getContextFn = () => window.SillyTavern.getContext();
    }
    if (!saveSettingsDebounced && typeof getContextFn === 'function') {
        saveSettingsDebounced = () => getContextFn()?.saveSettingsDebounced?.();
    }
    toastr = window.toastr || toastr;

    if (!eventSource || !event_types) {
        throw new Error('SillyTavern event bus is not available. Make sure the core scripts loaded before this extension.');
    }
}


/* ------------------------------------------------------------------------- */
/* Settings                                                                  */
/* ------------------------------------------------------------------------- */

function getSettings() {
    if (!extensionSettingsStore) {
        extensionSettingsStore = window.extension_settings = window.extension_settings || {};
    }
    if (!extensionSettingsStore[MODULE_NAME]) {
        extensionSettingsStore[MODULE_NAME] = { ...defaultSettings };
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extensionSettingsStore[MODULE_NAME][key] === undefined) {
            extensionSettingsStore[MODULE_NAME][key] = value;
        }
    }
    return extensionSettingsStore[MODULE_NAME];
}

function persistSettings() {
    try {
        saveSettingsDebounced?.();
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to persist settings:`, err);
    }
}

/* ------------------------------------------------------------------------- */
/* Choice parsing                                                            */
/* ------------------------------------------------------------------------- */

/** A numbered list item: "1. ...", "2) ...", optionally after a markdown bullet ("- 1. ..."). */
const ITEM_RE = /^\s{0,3}(?:[-*+]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
/** Horizontal-rule-only lines are allowed after the option run. */
const HR_RE = /^\s*([-*_]\s*){3,}$/;
/** A line that reads like a fresh "what do you do?" prompt rather than option text. Leading emphasis/parens allowed ("(Select 1-6, ...)", "*What do you do?*"). */
const PROMPT_LINE_RE = /^[*_(\s]*(?:select|choose|pick|what (?:do|will) you|your (?:move|choice|action|decision))\b/i;
/** A line that is only embedded media (image markdown / <img>), e.g. attached by an image-gen extension. */
const MEDIA_LINE_RE = /^(?:\s*(?:!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>)\s*)+$/i;
/** A bracketed directive line such as [SCENE_CHANGE] that media hooks leave after the list. */
const DIRECTIVE_RE = /^\s*\[[^\]\n]{1,60}\]\s*$/;

/**
 * A trailing status line injected by stat trackers, e.g.
 * "*理智 76/100 · 楼层 7（楼梯间） · 发现的客人 0 · 回合 5/150*":
 * a single line holding N/N counters separated by ·/|/•/│.
 * An optional user-supplied regex (setting) can mark extra formats.
 */
function isStatusLine(line, statusRe = null) {
    const t = line.trim().replace(/^[*_(]+|[*_)\s]+$/g, '').trim();
    if (!t) return false;
    if (statusRe && statusRe.test(t)) return true;
    const separators = (t.match(/[·|•│]/g) || []).length;
    return separators >= 2 && /\d+\s*\/\s*\d+/.test(t);
}

/** Lines that never count as narration when deciding what follows the option run. */
function isSkippableLine(line, statusRe = null) {
    return line.trim() === '' || HR_RE.test(line) || MEDIA_LINE_RE.test(line) || DIRECTIVE_RE.test(line) || isStatusLine(line, statusRe);
}

/** Strip markdown inline formatting so button labels and sent text stay clean. */
function cleanInline(s) {
    return String(s)
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .trim();
}

/** Short button label: the bold lead-in if present, else text up to a dash/colon or first sentence. */
function extractLabel(text) {
    const trimmed = String(text).trim();
    const bold = trimmed.match(/^\*\*([^*]+)\*\*/) || trimmed.match(/^__([^_]+)__/);
    let label = bold ? bold[1] : trimmed;
    label = cleanInline(label);
    if (!bold) {
        label = label.split(/\s+(?:--|—|–|:)\s+/)[0];
        const sentence = label.split(/(?<=[.!?])\s+/)[0];
        if (sentence && sentence.length <= 60) label = sentence;
    }
    if (label.length > 60) label = `${label.slice(0, 57).trimEnd()}…`;
    return label;
}

/**
 * Parse the LAST numbered list in a message (the "select an action" block).
 * The run must start at 1, be sequential, and contain at least minOptions items.
 * After the run, only blank/rule/prompt lines may follow — OR narrative epilogue,
 * but then the message must still end by asking for a choice (a prompt line such
 * as "What do you do?" / "(Select 1-6, ...)"), or a generation must still be
 * streaming (more text may be on its way, so we don't flicker the bar off).
 * @param {string} raw Raw message text (markdown).
 * @param {number} minOptions
 * @param {boolean} [allowTrailingNarrative] True while a generation is streaming.
 * @param {RegExp|null} [statusRe] User-configured regex marking extra trailing status lines.
 * @returns {Array<{number: number, label: string, text: string}>}
 */
function parseChoices(raw, minOptions, allowTrailingNarrative = false, statusRe = null) {
    if (!raw) return [];
    const lines = String(raw).split(/\r?\n/);

    // Index of the last meaningful line (media/directive lines don't count —
    // an image generated from [SCENE_CHANGE] may be appended after the list).
    let end = lines.length - 1;
    while (end >= 0 && isSkippableLine(lines[end], statusRe)) end--;
    if (end < 0) return [];

    // All numbered item starts up to `end`.
    const starts = [];
    for (let k = 0; k <= end; k++) {
        const m = lines[k].match(ITEM_RE);
        if (m) starts.push({ idx: k, num: Number(m[1]), firstLine: m[2] });
    }
    if (!starts.length) return [];

    // The trailing run = longest suffix of `starts` with sequential numbers.
    let runBegin = starts.length - 1;
    while (runBegin > 0 && starts[runBegin - 1].num === starts[runBegin].num - 1) runBegin--;
    const run = starts.slice(runBegin);
    if (run.length < minOptions || run.length > MAX_OPTIONS) return [];
    if (run[0].num !== 1) return [];

    const options = [];
    let lastContentLine = -1; // last line index that belongs to the final item
    for (let j = 0; j < run.length; j++) {
        const start = run[j];
        const stopIdx = (j + 1 < run.length) ? run[j + 1].idx : end + 1;
        const parts = [start.firstLine];
        lastContentLine = start.idx;
        let continuation = 0;
        for (let k = start.idx + 1; k < stopIdx; k++) {
            const t = lines[k].trim();
            // A blank/rule/media/directive/status line ends the item — content after a gap is not part of the option.
            if (isSkippableLine(lines[k], statusRe)) break;
            // Don't swallow a trailing "What do you do?" into the last option.
            if (PROMPT_LINE_RE.test(t)) break;
            // A runaway paragraph means this probably wasn't a choice list.
            if (++continuation > 3) break;
            parts.push(t);
            lastContentLine = k;
        }
        const text = cleanInline(parts.join(' '));
        options.push({ number: start.num, label: extractLabel(parts[0]), text });
    }

    // What follows the last item decides whether the run is really a choice list.
    // Blank/rule/prompt lines are always fine. Narrative epilogue (the model
    // wrapping up the scene after the list) is fine only when the message still
    // ENDS by asking for a choice, or while streaming (the prompt may not have
    // arrived yet — rejecting here is what made the bar flash and vanish).
    let sawNarrative = false;
    for (let k = lastContentLine + 1; k <= end; k++) {
        const t = lines[k].trim();
        if (isSkippableLine(lines[k], statusRe) || PROMPT_LINE_RE.test(t)) continue;
        sawNarrative = true;
    }
    if (sawNarrative && !allowTrailingNarrative && !PROMPT_LINE_RE.test(lines[end].trim())) return [];
    return options;
}

/** True when a message carries no readable text — e.g. a generated image attached after a choice list. */
function isMediaOnlyText(text) {
    return String(text ?? '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images
        .replace(/<img\b[^>]*>/gi, '') // HTML image tags
        .replace(/\bhttps?:\/\/\S+?\.(?:png|jpe?g|gif|webp|bmp|avif)(?:\?\S*)?/gi, '') // bare image URLs
        .trim() === '';
}

/** Text of the most recent message that can carry choices (current swipe).
 * Media-only replies (generated images with no readable text) are skipped so
 * the bar survives a picture appended after the list; hitting a user message
 * ends the search (the choice was already answered). */
function getLastChoiceSourceText() {
    try {
        const ctx = typeof getContextFn === 'function' ? getContextFn() : null;
        const chat = ctx?.chat;
        if (!Array.isArray(chat) || !chat.length) return null;
        for (let i = chat.length - 1, depth = 0; i >= 0 && depth < MAX_MEDIA_LOOKBACK; i--, depth++) {
            const msg = chat[i];
            if (!msg) continue;
            if (msg.is_user) return null;
            const text = typeof msg.mes === 'string' ? msg.mes : '';
            if (isMediaOnlyText(text)) continue; // generated picture / empty media message
            return text;
        }
        return null;
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to read chat:`, err);
        return null;
    }
}

/* ------------------------------------------------------------------------- */
/* Actions (all delegate to core UI/APIs so behavior matches stock buttons)  */
/* ------------------------------------------------------------------------- */

/** Click a core button exactly like a real user tap: a single native event.
 *  jQuery .trigger('click') can double-fire delegated handlers (trigger() calls
 *  the element's native click() after its own bubbling pass, re-dispatching the
 *  event) — that made the Options panel open and instantly close. */
function nativeClick(el) {
    el?.click?.();
}

function renderSendTemplate(option) {
    const template = String(getSettings().sendTemplate || defaultSettings.sendTemplate);
    return template
        .replaceAll('{{number}}', String(option.number))
        .replaceAll('{{label}}', option.label)
        .replaceAll('{{text}}', option.text)
        .trim();
}

/** Send a choice exactly as if the user typed it: fill the textarea and press Send. */
function sendChoice(option) {
    if (generating) return;
    const textarea = document.getElementById('send_textarea');
    const sendButton = document.getElementById('send_but');
    if (!textarea || !sendButton) {
        toastr.error?.('Message input is not available.', 'Choice Buttons');
        return;
    }
    textarea.value = renderSendTemplate(option);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    nativeClick(sendButton);
}

/** Continue the last message (same as the core Continue option / /continue). */
function doContinue() {
    if (generating) return;
    const option = document.getElementById('option_continue');
    if (option) {
        nativeClick(option);
        return;
    }
    if (typeof Generate === 'function') {
        Generate('continue');
    }
}

/** Abort the running generation (same as the core stop button). */
function doStop() {
    const stopButton = document.getElementById('mes_stop');
    if (stopButton && $(stopButton).is(':visible')) {
        nativeClick(stopButton);
        return;
    }
    if (typeof stopGeneration === 'function') {
        stopGeneration();
    }
}

/** Temporarily un-hide the core form while a core popup anchored inside it is
 *  open, then restore the hidden state once the popup closes. */
function withVisibleForm(action, popupId) {
    document.body.classList.remove('cob-hide-input');
    action();
    const popup = document.getElementById(popupId);
    if (!popup) {
        applyInputVisibility();
        return;
    }
    let tries = 0;
    const watcher = setInterval(() => {
        if (!$(popup).is(':visible') || ++tries > 300) { // ~2 min safety cap
            clearInterval(watcher);
            applyInputVisibility();
        }
    }, 400);
}

/** True while WE hold the options popup open (core's own visibility flag only
 *  tracks its own clicks, so its outside-click closer doesn't run for us). */
let optionsMenuSelfManaged = false;

function openOptionsMenu() {
    const menu = document.getElementById('options');
    if (!menu) return;
    withVisibleForm(() => {
        const $menu = $(menu);
        if ($menu.is(':visible')) {
            $menu.stop(true, true).fadeOut(150);
            optionsMenuSelfManaged = false;
            return;
        }
        // Show the popup directly instead of delegating a click to the core
        // burger: core closes it on any document click unless the real button
        // is :hover/:focus (isMouseOverButtonOrMenu), which a synthetic click
        // can never satisfy — the pointer rests on OUR button, and while the
        // form is hidden the real button cannot take focus either. We manage
        // outside-click closing ourselves (see wireEvents). Item clicks inside
        // the popup still run core's handlers as usual.
        $menu.stop(true, true).fadeIn(150);
        optionsMenuSelfManaged = true;
        // Core's Popper instance re-anchors on window resize — nudge it so the
        // popup tracks the (just un-hidden) burger button.
        window.dispatchEvent(new Event('resize'));
    }, 'options');
}

function openExtensionsMenu() {
    nativeClick(document.getElementById('extensionsMenuButton'));
}

/* ------------------------------------------------------------------------- */
/* Long-press preview                                                        */
/* ------------------------------------------------------------------------- */

function hidePreview() {
    document.getElementById(PREVIEW_ID)?.remove();
}

function showPreview(option, anchorEl) {
    hidePreview();
    const bubble = document.createElement('div');
    bubble.id = PREVIEW_ID;

    const body = document.createElement('div');
    body.textContent = `${option.number}. ${option.text}`;
    bubble.appendChild(body);

    const hint = document.createElement('div');
    hint.className = 'cob-preview-hint';
    hint.textContent = 'Release to dismiss — tap the button to send';
    bubble.appendChild(hint);

    document.body.appendChild(bubble);

    const rect = anchorEl.getBoundingClientRect();
    bubble.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bubble.offsetWidth - 8))}px`;
    bubble.style.bottom = `${window.innerHeight - rect.top + 8}px`;
}


/* ------------------------------------------------------------------------- */
/* Bar construction and rendering                                            */
/* ------------------------------------------------------------------------- */

function makeUtilButton(id, iconClass, title, onTap) {
    const btn = document.createElement('div');
    btn.id = id;
    btn.className = 'cob-btn cob-util';
    btn.title = title;
    btn.setAttribute('role', 'button');
    btn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onTap();
    });
    return btn;
}

function makeOptionButton(option) {
    const settings = getSettings();
    const btn = document.createElement('div');
    btn.className = 'cob-btn cob-opt';
    btn.title = option.text;
    btn.setAttribute('role', 'button');

    const num = document.createElement('span');
    num.className = 'cob-num';
    num.textContent = String(option.number);
    btn.appendChild(num);

    if (settings.showLabels && option.label) {
        const label = document.createElement('span');
        label.className = 'cob-label';
        label.textContent = option.label;
        btn.appendChild(label);
    }

    // Tap = send. Long-press = preview full text without sending (mobile-friendly).
    let pressTimer = null;
    let longPressed = false;
    btn.addEventListener('pointerdown', () => {
        longPressed = false;
        btn.classList.add('cob-pressed');
        if (!settings.longPressPreview) return;
        pressTimer = setTimeout(() => {
            longPressed = true;
            showPreview(option, btn);
        }, LONG_PRESS_MS);
    });
    const cancelPress = () => {
        btn.classList.remove('cob-pressed');
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
    };
    btn.addEventListener('pointerup', cancelPress);
    btn.addEventListener('pointercancel', cancelPress);
    btn.addEventListener('pointerleave', cancelPress);
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (longPressed) {
            longPressed = false;
            hidePreview();
            return;
        }
        sendChoice(option);
    });
    return btn;
}

function ensureBar() {
    if (barEl && document.body.contains(barEl)) return barEl;
    barEl = document.createElement('div');
    barEl.id = BAR_ID;
    barEl.className = 'cob-hidden';
    // Dock INSIDE #form_sheld (the bottom block of the #sheld flex column), right
    // above #send_form. Pure flow layout: always chat-width, always on screen —
    // no fixed-position/viewport math that breaks on mobile browsers.
    const sheld = document.getElementById('form_sheld');
    const form = document.getElementById('send_form');
    if (sheld && form) {
        sheld.insertBefore(barEl, form);
    } else if (document.body) {
        // Degraded fallback: fixed to the bottom of the page.
        barEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:1000;';
        document.body.appendChild(barEl);
    }
    return barEl;
}

function renderBar() {
    const settings = getSettings();
    const bar = ensureBar();
    bar.innerHTML = '';

    // First two: burger (options) + magic wand (extensions).
    bar.appendChild(makeUtilButton('cob-btn-options', 'fa-bars', 'Options', openOptionsMenu));
    bar.appendChild(makeUtilButton('cob-btn-wand', 'fa-wand-magic-sparkles', 'Extensions', openExtensionsMenu));

    // Middle: one stretched button per parsed option.
    for (const option of currentOptions) {
        const btn = makeOptionButton(option);
        if (generating) btn.classList.add('cob-disabled');
        bar.appendChild(btn);
    }

    // Last two: continue + stop, kept square like the first two.
    const continueBtn = makeUtilButton('cob-btn-continue', 'fa-arrow-right', 'Continue the last message', doContinue);
    if (generating) continueBtn.classList.add('cob-disabled');
    bar.appendChild(continueBtn);

    const stopBtn = makeUtilButton('cob-btn-stop', 'fa-circle-stop', 'Stop generation', doStop);
    stopBtn.classList.add('cob-stop');
    if (!generating) stopBtn.classList.add('cob-disabled');
    bar.appendChild(stopBtn);

    if (settings.showKeyboardButton) {
        bar.appendChild(makeUtilButton('cob-btn-keyboard', 'fa-keyboard', 'Show/hide the message input', () => {
            manualInputVisible = !manualInputVisible;
            applyInputVisibility();
        }));
    }
}


/* ------------------------------------------------------------------------- */
/* Input hiding                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Hide/show the core message bar. Uses visibility (not display) so the form
 * keeps its layout box: the Options/Extensions popups anchored to buttons
 * inside it still open in the right place, and the invisible textarea can
 * never be tapped, so the mobile keyboard never pops up.
 */
function applyInputVisibility() {
    const settings = getSettings();
    const barVisible = !!barEl && !barEl.classList.contains('cob-hidden') && currentOptions.length > 0;
    // Never hide the form while the core options popup is open — its Popper
    // anchor (the real burger) lives inside the form.
    const optionsPopupOpen = !!document.getElementById('options') && $('#options').is(':visible');
    const shouldHide = settings.enabled && settings.hideInput && barVisible && !manualInputVisible && !optionsPopupOpen;
    document.body.classList.toggle('cob-hide-input', shouldHide);
}

/** Compile the user's trailing-status-line regex; null when unset/invalid. */
function getStatusLineRe() {
    const pattern = String(getSettings().trailingStatusPattern || '').trim();
    if (!pattern) return null;
    try {
        return new RegExp(pattern, 'i');
    } catch {
        console.warn(`[${MODULE_NAME}] Invalid trailingStatusPattern regex:`, pattern);
        return null;
    }
}

/* ------------------------------------------------------------------------- */
/* Refresh                                                                   */
/* ------------------------------------------------------------------------- */

function refresh() {
    const settings = getSettings();
    hidePreview();

    if (!settings.enabled) {
        currentOptions = [];
        ensureBar().classList.add('cob-hidden');
        applyInputVisibility();
        return;
    }

    const raw = getLastChoiceSourceText();
    // While streaming, keep the bar up even if narrative currently trails the
    // list — the closing "what do you do?" prompt may not have arrived yet.
    currentOptions = raw ? parseChoices(raw, Math.max(2, Number(settings.minOptions) || 2), generating, getStatusLineRe()) : [];

    const bar = ensureBar();
    if (!currentOptions.length) {
        bar.classList.add('cob-hidden');
        applyInputVisibility();
        return;
    }

    renderBar();
    bar.classList.remove('cob-hidden');
    applyInputVisibility();
}

function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refresh();
    }, 60);
}


/* ------------------------------------------------------------------------- */
/* Settings panel (Extensions drawer)                                        */
/* ------------------------------------------------------------------------- */

function buildSettingsPanel() {
    const settings = getSettings();
    const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if (!container.length) {
        console.warn(`[${MODULE_NAME}] Extensions settings container not found; settings panel skipped.`);
        return;
    }

    const html = `
    <div class="adventure-choice-buttons-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Adventure Choice Buttons</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="cob_enabled">
                    <input id="cob_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                    <span>Enable choice buttons</span>
                </label>
                <label class="checkbox_label" for="cob_hide_input">
                    <input id="cob_hide_input" type="checkbox" ${settings.hideInput ? 'checked' : ''} />
                    <span>Hide the message bar while choices are shown (mobile: no accidental keyboard)</span>
                </label>
                <label class="checkbox_label" for="cob_show_labels">
                    <input id="cob_show_labels" type="checkbox" ${settings.showLabels ? 'checked' : ''} />
                    <span>Show option labels on buttons (off = numbers only)</span>
                </label>
                <label class="checkbox_label" for="cob_long_press">
                    <input id="cob_long_press" type="checkbox" ${settings.longPressPreview ? 'checked' : ''} />
                    <span>Long-press an option to preview its full text</span>
                </label>
                <label class="checkbox_label" for="cob_keyboard_button">
                    <input id="cob_keyboard_button" type="checkbox" ${settings.showKeyboardButton ? 'checked' : ''} />
                    <span>Add a keyboard button that un-hides the message bar</span>
                </label>
                <label class="checkbox_label" for="cob_keyboard_selection">
                    <input id="cob_keyboard_selection" type="checkbox" ${settings.keyboardSelection ? 'checked' : ''} />
                    <span>Number keys select options (1-9, 0 = 10)</span>
                </label>
                <label for="cob_send_template">Message sent when an option is tapped</label>
                <input id="cob_send_template" class="text_pole" type="text" />
                <small>Placeholders: <code>{{number}}</code>, <code>{{label}}</code> (short title), <code>{{text}}</code> (full option text).</small>
                <label for="cob_min_options">Minimum options needed to show the bar</label>
                <input id="cob_min_options" type="number" min="2" max="12" step="1" />
                <label for="cob_status_pattern">Trailing status-line pattern (regex, optional)</label>
                <input id="cob_status_pattern" class="text_pole" type="text" placeholder="e.g. ^理智 .*回合" />
                <small>Lines matching this after the option list are ignored. A built-in heuristic already covers
                    lines like <code>理智 76/100 · 楼层 7 · 回合 5/150</code> (N/N counters with ·/|/• separators).</small>
            </div>
        </div>
    </div>`;

    container.append(html);

    $('#cob_send_template').val(settings.sendTemplate);
    $('#cob_min_options').val(Number(settings.minOptions) || 2);

    $('#cob_enabled').on('change', function () { getSettings().enabled = this.checked; persistSettings(); scheduleRefresh(); });
    $('#cob_hide_input').on('change', function () { getSettings().hideInput = this.checked; persistSettings(); applyInputVisibility(); });
    $('#cob_show_labels').on('change', function () { getSettings().showLabels = this.checked; persistSettings(); scheduleRefresh(); });
    $('#cob_long_press').on('change', function () { getSettings().longPressPreview = this.checked; persistSettings(); });
    $('#cob_keyboard_button').on('change', function () {
        getSettings().showKeyboardButton = this.checked;
        if (!this.checked) manualInputVisible = false;
        persistSettings();
        scheduleRefresh();
    });
    $('#cob_keyboard_selection').on('change', function () { getSettings().keyboardSelection = this.checked; persistSettings(); });
    $('#cob_send_template').on('input', function () { getSettings().sendTemplate = String($(this).val()); persistSettings(); });
    $('#cob_min_options').on('change', function () { getSettings().minOptions = Number($(this).val()) || 2; persistSettings(); scheduleRefresh(); });
    $('#cob_status_pattern').val(String(settings.trailingStatusPattern || ''));
    $('#cob_status_pattern').on('input', function () { getSettings().trailingStatusPattern = String($(this).val()); persistSettings(); scheduleRefresh(); });
}


/* ------------------------------------------------------------------------- */
/* Event wiring and init                                                     */
/* ------------------------------------------------------------------------- */

function wireEvents() {
    // Re-parse whenever the last assistant message can change.
    eventSource.on(event_types.MESSAGE_RECEIVED, scheduleRefresh);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleRefresh);
    eventSource.on(event_types.MESSAGE_SWIPED, scheduleRefresh);
    eventSource.on(event_types.MESSAGE_EDITED, scheduleRefresh);
    eventSource.on(event_types.MESSAGE_UPDATED, scheduleRefresh);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        manualInputVisible = false;
        generating = false;
        scheduleRefresh();
    });

    // Track generation state: disable options/continue, enable stop.
    // GENERATION_STARTED also fires for background ('quiet') generations;
    // those never show the core stop button, so they must not lock the bar.
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (type === 'quiet' || dryRun) return;
        generating = true;
        scheduleRefresh();
    });
    const onGenerationFinished = () => {
        generating = false;
        scheduleRefresh();
    };
    eventSource.on(event_types.GENERATION_ENDED, onGenerationFinished);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

    // The bar docks in flow inside #form_sheld, so there is no geometry to keep
    // in sync across resizes / mobile viewport changes — nothing to do here.

    // Any tap outside the long-press preview dismisses it.
    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest?.(`#${PREVIEW_ID}`)) hidePreview();
    }, true);

    // Outside tap closes a self-opened options popup (core's closer only runs
    // when ITS flag is set, which showing the popup directly doesn't do).
    document.addEventListener('pointerdown', (e) => {
        if (!optionsMenuSelfManaged) return;
        const menu = document.getElementById('options');
        if (!menu || !$(menu).is(':visible')) {
            optionsMenuSelfManaged = false;
            return;
        }
        if (e.target.closest?.('#options') || e.target.closest?.('#cob-burger')) return;
        $(menu).fadeOut(150);
        optionsMenuSelfManaged = false;
    }, true);

    // Number keys trigger the matching option (1-9, 0 = option 10).
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
        if (!/^[0-9]$/.test(e.key)) return;
        if (generating || !getSettings().keyboardSelection) return;
        if (!barEl || barEl.classList.contains('cob-hidden') || !currentOptions.length) return;
        // Never steal digits from an editable field.
        if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        const num = e.key === '0' ? 10 : Number(e.key);
        const option = currentOptions.find(o => o.number === num);
        if (!option) return;
        e.preventDefault();
        sendChoice(option);
    });
}

async function init() {
    console.log(`[${MODULE_NAME}] Initializing... (build ${BUILD_ID})`);
    ensureStylesheet();
    await loadScriptApi();
    getSettings();
    ensureBar();
    buildSettingsPanel();
    wireEvents();

    // Initial state: mirror the core stop button in case we load mid-generation.
    const stopButton = document.getElementById('mes_stop');
    generating = !!(stopButton && $(stopButton).is(':visible'));

    refresh();
    console.log(`[${MODULE_NAME}] Ready.`);
}

// SillyTavern loads extension JS as a module and does not call exported init
// functions, so self-execute once the DOM (and jQuery) is ready — same pattern
// as the other extensions in this workspace.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        jQuery(async () => { await init(); });
    });
} else {
    jQuery(async () => { await init(); });
}

