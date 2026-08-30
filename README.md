# Adventure Choice Buttons for SillyTavern

A mobile-first UI extension for choice-based adventures. It watches the last
assistant message for a trailing numbered list (the "Select an action:" block)
and docks a full-width button bar where the message input normally sits.

## What it does

1. **Auto-spawns buttons from the last choice section.** If the message ends
   with a numbered list (e.g. `1. **Visit the holding cell** -- ...`), one
   button per option is created. With 6 options you get 10 buttons total;
   with 4 options you get 8:
   - **Button 1 — ☰ burger**: opens the core Options panel (same as `#options_button`).
   - **Button 2 — 🪄 magic wand**: opens the core Extensions menu (same as `#extensionsMenuButton`).
   - **Middle — option buttons**: tapping one fills the send box with the
     choice (template configurable) and presses Send, exactly as if typed.
   - **Second-to-last — ➡ continue**: triggers the core Continue
     (`#option_continue`, same as `/continue`) for stuck/truncated messages.
   - **Last — ⏹ stop**: aborts the running generation (same as `#mes_stop`);
     disabled when idle, enabled while generating.
2. **Stretches the option buttons to the chat width.** The bar is pinned to
   the `#send_form` rectangle, so it always matches the chat width; option
   buttons flex to fill the row and wrap onto extra full-width rows on narrow
   screens. The first two and last two utility buttons stay square (46px
   touch targets).
3. **Hides the message bar while choices are shown.** Hiding uses
   `visibility: hidden` (not `display: none`), so the hidden textarea can
   never be tapped — the mobile keyboard never pops up by accident — while
   the Options/Extensions popups anchored inside the form still open in the
   right place. When a message has no choices, the input comes back so free
   typing is still possible.
4. **Mobile extras**: long-press an option button to preview its full text
   before sending; safe-area padding; a spacer keeps the last message
   scrollable clear of the bar.

## Parsing rules

- Only the **last** numbered run in the message is used, and only if it
  starts at `1`, is sequential (`1, 2, 3, ...`), has at least `minOptions`
  items (default 2, max 12), and nothing but blank/rule lines follows it.
- Markdown (`**bold**`, `*italic*`, links) is stripped from labels and sent text.
- The button label is the option's bold lead-in if present
  (`1. **Visit the holding cell** -- observe ...` → "Visit the holding cell"),
  otherwise the text up to the first `--`, `—`, `:` or sentence end (max 60 chars).

## Settings (Extensions drawer → Adventure Choice Buttons)

| Setting | Default | Notes |
|---|---|---|
| Enable choice buttons | on | Master toggle. |
| Hide the message bar while choices are shown | on | Mobile anti-keyboard-pop behavior. |
| Show option labels on buttons | on | Off = numbers only. |
| Long-press to preview full text | on | |
| Add a keyboard button | off | Extra ⌨ utility button that un-hides the input manually. |
| Message sent when tapped | `{{number}}. {{label}}` | Placeholders: `{{number}}`, `{{label}}`, `{{text}}` (full option text). |
| Minimum options | 2 | Below this the bar stays hidden and the input remains visible. |

## Install / deploy

Repository: <https://github.com/owlket/adventure-choice-buttons> (private).

### Deploy from GitHub

On any machine with the repo cloned:

```bash
git clone https://github.com/owlket/adventure-choice-buttons.git
```

Then deploy the extension files to SillyTavern (from a clone of this repo):

**Local SillyTavern (from the workspace):**

```powershell
.\plugins\adventure-choice-buttons\deploy-extension.ps1
```

**Production Docker host** (`root@10.10.10.124`, SillyTavern at
`/opt/sillytavern/`) — run from the repo root, and copy files INTO the existing
bind-mounted extension directory — do not `rm -rf` the directory itself (see
the adventure-launcher README for why):

```bash
git clone https://github.com/owlket/adventure-choice-buttons.git
cd adventure-choice-buttons
scp extension/index.js extension/manifest.json extension/style.css \
    root@10.10.10.124:/opt/sillytavern/public/extensions/adventure-choice-buttons/
```

Then hard-refresh the browser (the extension injects its own cache-busted
stylesheet link, but a stale `index.js` still needs a refresh).

## Notes / limitations

- Choice lists must be the **last** block of the assistant message; a numbered
  list in the middle of narration is ignored by design.
- While a generation is running, option and continue buttons are disabled and
  only stop stays active. Background ("quiet") generations from other
  extensions do not lock the bar.
- Works in both `public/scripts/extensions/<name>` and
  `public/scripts/extensions/third-party/<name>` layouts (module paths are
  resolved relative to `import.meta.url`).
