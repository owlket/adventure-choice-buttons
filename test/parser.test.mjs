// Parser tests: extracts the pure parsing functions from the extension's index.js
// (slicing the "Choice parsing" section) and exercises them against sample messages.
// Run from the workspace root:  node plugins/adventure-choice-buttons/test/parser.test.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = src.indexOf('const ITEM_RE');
const end = src.indexOf('/** Text of the most recent message that can carry choices');
if (start < 0 || end < 0) throw new Error('Could not locate parser section in index.js');
const section = src.slice(start, end);

const factory = new Function(`const MAX_OPTIONS = 12;\n${section}\nreturn { parseChoices, extractLabel, cleanInline, isMediaOnlyText };`);
const { parseChoices, isMediaOnlyText } = factory();

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}`);
    if (!ok) {
        failures++;
        console.log('  expected:', JSON.stringify(expected));
        console.log('  actual:  ', JSON.stringify(actual));
    }
}

// --- Case 1: screenshot-style message, 6 options, bold labels, wrapping continuation lines ---
const msg6 = `There's a note in the margin of the incident report, handwritten by someone who didn't sign it.

"That's everything we have," Vasquez says. "What do you want to do first?"

---

**Select an action:**

1. **Visit the holding cell** -- observe the anomaly directly from behind the observation glass. See if you can identify the secretion rate and the
expression shift the photographs hinted at.
2. **Review the recovery team's debrief transcripts** -- dig into the specific language the anomaly used and how the team members reacted.
Pattern-match the persuasion effect.
3. **Pull the autopsy report on the estate owner** -- fourteen years of proximity, one dead body.
4. **Ask Vasquez to interview the two recovery team members who requested reassignment** -- they wanted to *talk* to it.
5. **Query Records** — search the Foundation archive for precedent on anomalous objects exhibiting persuasive communication.
6. **Submit Classification**`;

const r1 = parseChoices(msg6, 2);
check('6 options detected', r1.length, 6);
check('option 1 label', r1[0]?.label, 'Visit the holding cell');
check('option 6 label', r1[5]?.label, 'Submit Classification');
check('option 1 text includes wrapped continuation', r1[0]?.text.includes('expression shift'), true);
check('option 4 strips italic markers', r1[3]?.text.includes('*talk*'), false);

// --- Case 2: 4 options, no bold, dash separators ---
const msg4 = `You reach the fork in the corridor. The air smells of ozone.

Select an option:
1. Take the left passage -- it slopes downward.
2. Take the right passage -- faint light flickers.
3. Wait and listen at the fork.
4. Head back to the surface.`;

const r2 = parseChoices(msg4, 2);
check('4 options detected', r2.length, 4);
check('option 3 label cut at sentence', r2[2]?.label, 'Wait and listen at the fork.');
check('option 1 label cut at dash', r2[0]?.label, 'Take the left passage');

// --- Case 3: numbered list NOT at the end -> no buttons ---
const msgMid = `Here are your options:
1. First thing.
2. Second thing.

But before you decide, the ground trembles beneath your feet and everything changes.`;
check('mid-message list ignored', parseChoices(msgMid, 2).length, 0);

// --- Case 4: no numbers at all ---
check('no list -> no buttons', parseChoices('Just narration, no choices here.', 2).length, 0);

// --- Case 5: parenthesis numbering + trailing rule/blank lines ---
const msgParen = `What now?

1) Kick the door.
2) Knock politely.
3) Walk away.

---
`;
const r5 = parseChoices(msgParen, 2);
check('parenthesis numbering detected', r5.length, 3);
check('paren label', r5[1]?.label, 'Knock politely.');

// --- Case 6: single option below minOptions -> ignored ---
check('single option ignored', parseChoices('Only one way:\n1. Go on.', 2).length, 0);

// --- Case 7: trailing "what do you do?" line is not swallowed into the last option ---
const msgPrompt = `Pick one:
1. **Run** -- fast.
2. **Hide** -- quietly.

What do you do?`;
const r7 = parseChoices(msgPrompt, 2);
check('prompt-ending message: 2 options', r7.length, 2);
check('last option not polluted by prompt line', r7[1]?.text.includes('What do you do'), false);

// --- Case 8: non-sequential numbering -> ignored ---
check('non-sequential ignored', parseChoices('1. A\n3. B\n4. C', 2).length, 0);

// --- Case 9: list followed by epilogue narration, message still ends asking for a choice ---
// (This is the reported bug: the bar flashed when option 6 streamed in, then vanished
// once the closing narration + prompt lines arrived after the list.)
const msgEpilogue = `**Select an action:**

1. **Visit the holding cell** -- observe the anomaly directly.
2. **Review the debrief transcripts** -- dig into the language used.
3. **Submit Classification** The briefing room hums in the quiet after Vasquez's question.

The air recyclers click through their cycle. Somewhere below your feet, something is waiting.

What do you do?

(Select 1-3, or describe your own action.)`;

const r9 = parseChoices(msgEpilogue, 2);
check('epilogue + prompt ending: options detected', r9.length, 3);
check('epilogue: last label intact', r9[2]?.label, 'Submit Classification');
check('epilogue not swallowed into last option', r9[2]?.text.includes('air recyclers'), false);

// --- Case 10: same shape but message ends with narration -> still ignored (strict mode) ---
const msgEpilogueNoPrompt = `Pick one:
1. **Run** -- fast.
2. **Hide** -- quietly.

The ground trembles beneath your feet and everything changes.`;
check('epilogue without prompt ending ignored', parseChoices(msgEpilogueNoPrompt, 2).length, 0);

// --- Case 11: streaming mode keeps the bar while the closing prompt has not arrived yet ---
check('streaming: trailing narration tolerated', parseChoices(msgEpilogueNoPrompt, 2, true).length, 2);
check('streaming: mid-message list also tolerated', parseChoices(msgMid, 2, true).length, 2);

// --- Case 12: parenthesized prompt line counts as a prompt ---
check('"(Select 1-6, ...)" is a prompt line', PROMPT_LINE_RE_TEST(), true);
function PROMPT_LINE_RE_TEST() {
    // Re-derive from the sliced section: parseChoices behavior is the observable surface.
    const msg = '1. **A** -- one.\n2. **B** -- two.\n\n(Select 1-2, or describe your own action.)';
    return parseChoices(msg, 2).length === 2;
}

// --- Case 14: list followed by [SCENE_CHANGE] + generated image (image-gen hook output) ---
// The reported "after an image gen the chat box reverts" case: media/directive lines
// appended after the list must not kill the parse.
const msgSceneImage = `The hall falls silent.

1. **Approach the high table** -- address the headmaster directly.
2. **Take the empty seat** -- blend in and listen.
3. Write your own action.

[SCENE_CHANGE]

![generated scene](user/images/scene-1.png)`;
const r14 = parseChoices(msgSceneImage, 2);
check('directive + image after list: options detected', r14.length, 3);
check('image not swallowed into last option', r14[2]?.text.includes('SCENE_CHANGE'), false);

// --- Case 15: image line directly after the last item, no blank line ---
const msgImageTight = `1. **Run** -- fast.\n2. **Hide** -- quietly.\n![img](x.png)`;
check('tight image line after list: detected', parseChoices(msgImageTight, 2).length, 2);

// --- Case 16: narrative after list + image, no closing prompt -> still ignored (strict) ---
const msgNarrativeImage = `1. **Run** -- fast.\n2. **Hide** -- quietly.\n\nYou slip away into the dark.\n\n![img](x.png)`;
check('narrative + image without prompt ignored', parseChoices(msgNarrativeImage, 2).length, 0);
check('narrative + image tolerated while streaming', parseChoices(msgNarrativeImage, 2, true).length, 2);

// --- Case 18: Chinese world with trailing stat-tracker line after an HR ---
// (Reported: Chinese worlds never/semi detected — the "理智 76/100 · 楼层 7 · 回合 5/150"
// status line after the list made the strict trailing check fail once generation ended.)
const msgCn = `门下面那股洗衣液的味道还在往上升。温暖的，舒适的。

**你要怎么做?**

1. **下楼** — 打开六楼的门，进入楼层。
2. **对抗** — 用意志力抵抗那个气味的引诱，交换信息。
3. **压制** — 坚决无视那个气味，问林暮更实际的问题。
4. **等待** — 等气味消散再行动。
5. **警惕** — 质疑林暮：她为什么会知道"它在喂你"这个机制？
6. **自由输入**

---

*理智 76/100 · 楼层 7（楼梯间） · 发现的客人 0 · 回合 5/150*`;

const r18 = parseChoices(msgCn, 2);
check('status line after HR: 6 options detected', r18.length, 6);
check('status line: option 1 label', r18[0]?.label, '下楼');
check('status line not in last option text', r18[5]?.text.includes('理智'), false);

// --- Case 19: narrative after list + status line, no prompt -> still rejected (strict) ---
const msgCnStrict = `1. **走** — 快。\n2. **留** — 静。\n\n你转身离开，没有再回头。\n\n---\n\n*理智 76/100 · 楼层 7 · 回合 5/150*`;
check('narrative + status line without prompt ignored', parseChoices(msgCnStrict, 2).length, 0);

// --- Case 20: user-configured regex marks a custom status line ---
const msgCustomStatus = `1. **A** -- one.\n2. **B** -- two.\n\n【状态】心情：平静，第 3 天`;
check('custom status line rejected without regex', parseChoices(msgCustomStatus, 2).length, 0);
check('custom status line accepted via user regex', parseChoices(msgCustomStatus, 2, false, /^【状态】/).length, 2);

// --- Case 17: media-only detection (generated image messages) ---
check('markdown image is media-only', isMediaOnlyText('![generated](user/images/foo.png)'), true);
check('html image is media-only', isMediaOnlyText('<img src="user/images/foo.png" alt="">'), true);
check('bare image URL is media-only', isMediaOnlyText('https://example.com/pic.webp'), true);
check('empty text is media-only', isMediaOnlyText(''), true);
check('caption + image is NOT media-only', isMediaOnlyText('Look at this: ![img](x.png)'), false);
check('plain narration is NOT media-only', isMediaOnlyText('The door creaks open.'), false);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
