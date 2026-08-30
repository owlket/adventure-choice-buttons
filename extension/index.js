const MODULE_NAME = 'adventure-choice-buttons';
/** Build marker shown in logs; also used as the stylesheet cache-buster (same trick as adventure-launcher — mobile browsers hold stale CSS for a long time). */
const BUILD_ID = '1.0.0';
const STYLESHEET_LINK_ID = 'adventure-choice-buttons-css';
const BAR_ID = 'cob-bar';
const SPACER_ID = 'cob-spacer';
const PREVIEW_ID = 'cob-preview';
const LONG_PRESS_MS = 500;
const MAX_OPTIONS = 12;

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
/** A line that reads like a fresh "what do you do?" prompt rather than option text. */
const PROMPT_LINE_RE = /^\**\s*(select|choose|pick|what (do|will) you|your (move|choice|action|decision))\b/i;

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
 * Parse the LAST trailing numbered list in a message (the "select an action" block).
 * The run must start at 1, be sequential, contain at least minOptions items,
 * and reach the end of the message (only blank/rule lines may follow).
 * @param {string} raw Raw message text (markdown).
 * @param {number} minOptions
 * @returns {Array<{number: number, label: string, text: string}>}
 */
function parseChoices(raw, minOptions) {
    if (!raw) return [];
    const lines = String(raw).split(/\r?\n/);

    // Index of the last meaningful line.
    let end = lines.length - 1;
    while (end >= 0 && (lines[end].trim() === '' || HR_RE.test(lines[end]))) end--;
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
            // A blank/rule line ends the item — content after a gap is not part of the option.
            if (!t || HR_RE.test(lines[k])) break;
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

    // The run must be the final content of the message: after the last item,
    // only blank/rule lines or a closing "what do you do?" prompt may follow.
    for (let k = lastContentLine + 1; k <= end; k++) {
        const t = lines[k].trim();
        if (!t || HR_RE.test(lines[k]) || PROMPT_LINE_RE.test(t)) continue;
        return [];
    }
    return options;
}

/** Raw text of the last assistant message (current swipe), or null if the last message is the user's/system's. */
function getLastAssistantText() {
    try {
        const ctx = typeof getContextFn === 'function' ? getContextFn() : null;
        const chat = ctx?.chat;
        if (!Array.isArray(chat) || !chat.length) return null;
        const last = chat[chat.length - 1];
        if (!last || last.is_user || last.is_system) return null;
        return typeof last.mes === 'string' ? last.mes : null;
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to read chat:`, err);
        return null;
    }
}

/* ------------------------------------------------------------------------- */
/* Actions (all delegate to core UI/APIs so behavior matches stock buttons)  */
/* ------------------------------------------------------------------------- */

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
    $(sendButton).trigger('click');
}

/** Continue the last message (same as the core Continue option / /continue). */
function doContinue() {
    if (generating) return;
    const option = document.getElementById('option_continue');
    if (option) {
        $(option).trigger('click');
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
        $(stopButton).trigger('click');
        return;
    }
    if (typeof stopGeneration === 'function') {
        stopGeneration();
    }
}

function openOptionsMenu() {
    const button = document.getElementById('options_button');
    if (button) $(button).trigger('click');
}

function openExtensionsMenu() {
    const button = document.getElementById('extensionsMenuButton');
    if (button) $(button).trigger('click');
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
    document.body.appendChild(barEl);
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
/* Geometry, input hiding, chat spacer                                       */
/* ------------------------------------------------------------------------- */

/** Pin the bar to the #send_form rect so it always matches the chat width. */
function syncBarGeometry() {
    const bar = ensureBar();
    const form = document.getElementById('send_form');
    if (!form) return;
    const rect = form.getBoundingClientRect();
    bar.style.left = `${rect.left}px`;
    bar.style.width = `${rect.width}px`;
    bar.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom)}px`;
}

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

/**
 * Keep the last message scrollable clear of the bar: when the bar is taller
 * than the stock send form, add a spacer at the end of #chat for the difference.
 */
function syncChatSpacer() {
    const chat = document.getElementById('chat');
    const form = document.getElementById('send_form');
    document.getElementById(SPACER_ID)?.remove();
    if (!chat || !form || !barEl || barEl.classList.contains('cob-hidden')) return;
    const extra = barEl.offsetHeight - form.offsetHeight;
    if (extra <= 0) return;
    const spacer = document.createElement('div');
    spacer.id = SPACER_ID;
    spacer.style.height = `${extra + 8}px`;
    chat.appendChild(spacer);
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
        syncChatSpacer();
        return;
    }

    const raw = getLastAssistantText();
    currentOptions = raw ? parseChoices(raw, Math.max(2, Number(settings.minOptions) || 2)) : [];

    const bar = ensureBar();
    if (!currentOptions.length) {
        bar.classList.add('cob-hidden');
        applyInputVisibility();
        syncChatSpacer();
        return;
    }

    renderBar();
    syncBarGeometry();
    bar.classList.remove('cob-hidden');
    applyInputVisibility();
    // The spacer must be re-appended after core appends new message nodes.
    requestAnimationFrame(syncChatSpacer);
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

    // Keep the bar pinned to the send form across resizes / mobile viewport changes.
    window.addEventListener('resize', () => {
        if (barEl && !barEl.classList.contains('cob-hidden')) {
            syncBarGeometry();
            syncChatSpacer();
        }
    });
    window.visualViewport?.addEventListener('resize', () => {
        if (barEl && !barEl.classList.contains('cob-hidden')) {
            syncBarGeometry();
            syncChatSpacer();
        }
    });

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

