const MODULE_NAME = 'adventure-choice-buttons';
/** Build marker shown in logs; also used as the stylesheet cache-buster (same trick as adventure-launcher — mobile browsers hold stale CSS for a long time). */
const BUILD_ID = '1.3.0';
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

/** Lines that never count as narration when deciding what follows the option run. */
function isSkippableLine(line) {
    return line.trim() === '' || HR_RE.test(line) || MEDIA_LINE_RE.test(line) || DIRECTIVE_RE.test(line);
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
 * @returns {Array<{number: number, label: string, text: string}>}
 */
function parseChoices(raw, minOptions, allowTrailingNarrative = false) {
    if (!raw) return [];
    const lines = String(raw).split(/\r?\n/);

    // Index of the last meaningful line (media/directive lines don't count —
    // an image generated from [SCENE_CHANGE] may be appended after the list).
    let end = lines.length - 1;
    while (end >= 0 && isSkippableLine(lines[end])) end--;
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
            // A blank/rule/media/directive line ends the item — content after a gap is not part of the option.
            if (isSkippableLine(lines[k])) break;
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
        if (isSkippableLine(lines[k]) || PROMPT_LINE_RE.test(t)) continue;
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

function openOptionsMenu() {
    const button = document.getElementById('options_button');
    if (!button) return;
    // Core script.js closes the options popup on any document click unless the
    // button or popup is :hover/:focus (isMouseOverButtonOrMenu). A synthetic
    // click has neither — the pointer rests on OUR button — so the popup opened
    // and the very same click immediately closed it. Focus the real button first.
    if (!button.hasAttribute('tabindex')) button.setAttribute('tabindex', '-1');
    button.focus({ preventScroll: true });
    nativeClick(button);
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
    const shouldHide = settings.enabled && settings.hideInput && barVisible && !manualInputVisible;
    document.body.classList.toggle('cob-hide-input', shouldHide);
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
    currentOptions = raw ? parseChoices(raw, Math.max(2, Number(settings.minOptions) || 2), generating) : [];

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
                <label for="cob_send_template">Message sent when an option is tapped</label>
                <input id="cob_send_template" class="text_pole" type="text" />
                <small>Placeholders: <code>{{number}}</code>, <code>{{label}}</code> (short title), <code>{{text}}</code> (full option text).</small>
                <label for="cob_min_options">Minimum options needed to show the bar</label>
                <input id="cob_min_options" type="number" min="2" max="12" step="1" />
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
    $('#cob_send_template').on('input', function () { getSettings().sendTemplate = String($(this).val()); persistSettings(); });
    $('#cob_min_options').on('change', function () { getSettings().minOptions = Number($(this).val()) || 2; persistSettings(); scheduleRefresh(); });
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

