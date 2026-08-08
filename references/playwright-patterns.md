# Smartbi Playwright Patterns

## Browser Lifecycle

### Primary mode: headed Chrome over CDP

The project currently prefers a visible, headed Chrome so the user can inspect
the same browser that automation controls. Start exactly one managed process
with a dedicated profile:

```text
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  --remote-debugging-port=9222
  --user-data-dir=/tmp/smartbi-playwright-profile-cdp
  --no-first-run
  --no-default-browser-check
  --new-window
  https://smartbi.example.com/smartbi/vision/index.jsp
```

Keep it running for the whole workflow. Do not launch a second Chrome against
the same profile. Do not switch to headless unless the user asks; both modes
provide CDP control, but the headed process is the observable work surface.

For this authorized demo tenant, authentication may read the configured
two-line credentials file. Prefer `node scripts/smartbi.mjs login`; if UI login
is required, fill from the file without printing, returning, or inspecting the
password. Never take a screenshot while credential fields contain values.

Headless is an optional unattended mode using the same arguments plus
`--headless=new`, but only after the headed profile owner is stopped.

## Connection Pattern

```js
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const pages = context.pages();
const workspace = pages.find((page) => page.url().includes('/smartbi/vision/index.jsp'));
```

A one-shot script should call `process.exit(0)` after emitting safe results. Closing the CDP socket this way leaves Chrome and its session running. Do not call `browser.close()` on a browser that must remain available.

## Safe Page Discovery

Never select the first page by domain alone. AIChat and documentation pages may use the same or related domains.

```js
const workspace = context.pages().find((page) =>
  page.url().includes('/smartbi/vision/index.jsp'));

const aichat = context.pages().find((page) =>
  page.url().includes('/smartbi/vision/aichat/proxy/') || page.url().includes('/aichat/'));
```

After actions that may open a tab:

```js
const before = new Set(context.pages());
await action.click({ noWaitAfter: true });
await workspace.waitForTimeout(500);
const opened = context.pages().find((page) => !before.has(page));
```

AIChat is observed to open at a URL containing `/smartbi/vision/aichat/proxy/#/canvas/chat`.

## Navigation Pattern

Smartbi sidebar items are list elements. Some modules do not expose a `title` attribute consistently, so use exact text inside the sidebar container:

```js
const moduleName = '数据准备';
const navigation = workspace.locator('li.sidebar-menu-container')
  .filter({ hasText: new RegExp(`^\\s*${moduleName}\\s*$`) })
  .first();

if (await navigation.count() !== 1) {
  throw new Error(`Expected one sidebar module: ${moduleName}`);
}

await navigation.click({ force: true, noWaitAfter: true });
```

Use `force: true` only after asserting the locator is unique. The sidebar may be visually overlapped by Smartbi's own panels while still being the correct navigation target.

Observed module markers:

| Module | Safe visible marker after navigation |
|---|---|
| `数据连接` | `文件` |
| `数据准备` | `自助ETL`, `数据模型` |
| `分析展现` | `即席查询`, `透视分析`, `交互式仪表盘` |
| `运维设置` | `AIChat系统选项` |
| `AIChat` | New/existing page URL contains `/aichat/` |

Wait for a marker or URL, not a blind long delay.

## Locator Priority

Use in this order:

1. Role plus accessible name: `getByRole(...)`.
2. Stable user-facing label: `getByText(label, { exact: true })`.
3. Form label: `getByLabel(...)`.
4. Stable attribute observed in the current page.
5. Scoped CSS class plus exact text.

Avoid coordinates, generated IDs, icon glyphs, `nth()` without a preceding uniqueness check, and selectors copied from a prior render.

For resource trees, scope every locator to the known panel and folder before selecting a node. Duplicate labels are common across hidden panes.

## Tree Selection Requires Real Pointer Events (verified 2026-08-08)

Synthetic DOM clicks (`el.click()` / `dispatchEvent(new MouseEvent('click', ...))`)
do NOT select tree nodes in the data-import target tree (`.tree_nodepaneTitle`,
`data-qtp="freequery_tree_TreeNodeIcon"`). Selection state is driven by the
widget's own pointer handlers.

Working pattern:

```js
// 1. open the combobox dropdown first
await comboInput.click({ force: true });      // input.combobox-edit
await page.waitForTimeout(800);
// 2. real Playwright click on the exact pane title
const titles = layer.locator('.tree_nodepaneTitle');
for (let i = 0; i < await titles.count(); i++) {
  const t = await titles.nth(i).textContent();
  if (t && t.trim() === '可导入数据库') {
    await titles.nth(i).click({ force: true });
    break;
  }
}
// 3. verify selection landed
await comboInput.inputValue(); // e.g. 可导入数据库\input\数据采集空间\<account>
```

Dialog visibility is flaky: `layui-layer-page` elements may report
`offsetParent === null` while still functional. Scope to the dialog by title
text and use `force: true` clicks; verify by observable state (combobox value),
not by visibility.

## SPA And Modal Rules

- Smartbi rerenders components without changing the top-level URL.
- Reacquire locators after navigation, save, run, tab switch, or modal close.
- Before another action, resolve visible dialogs first.
- Use `getByRole('dialog')` when available and scope buttons to that dialog.
- Never click a generic `确定` or `保存` without verifying the dialog title and intended artifact.
- Treat toast success as a signal, then verify the artifact itself.

## Upload Pattern

1. Navigate to the exact file-import page.
2. Resolve the file input within the import panel.
3. Check source file path and expected file type.
4. Call `setInputFiles()` only after authorization and privacy checks.
5. Wait for the table/sheet preview.
6. Compare expected and discovered sheets.
7. Configure import target.
8. Submit and wait for terminal success/error.
9. Verify imported resources in the tree.

Do not print file contents or full previews when sources contain sensitive data.

## Drag-And-Drop Pattern

For ETL nodes, model tables, fields, and dashboard components:

1. Resolve source and destination by visible labels inside named panels.
2. Scroll both into view.
3. Prefer Playwright `dragTo()`.
4. Verify the destination contains the item.
5. If native drag fails, inspect pointer events before using mouse coordinates.
6. Never continue after an unverified drag.

## Verified QTP And State Markers (2026-08-08)

Prefer these stable semantic attributes after checking page URL and visible
panel. Generated IDs and resource node IDs are session/resource-specific.

| Surface | Marker/action |
|---|---|
| ETL canvas | `.dataprepare_graph-alias`; save `[qtp="toolbar-btn-SAVED"]`; run control text `运行` |
| Data model | source card `[qtp="SlideTaskPanel-AUGMENTED_DATASET"]`; basic table menu `[qtp="pop-menu_BASIC_TABLE"]`; save `[qtp="AugmentedToolbar-save"]` |
| Pivot | URL contains `#/adhocanalysis/create`; field nodes expose QTPs ending in the exact field name; run then save |
| Dashboard | URL contains `#/dashboard/`; bar chart card `[qtp="ECHARTS_BAR"]`; properties `[qtp="COMPONENT_SETTING"]`; save dialog under `.SaveDialogContent` |
| Graph manager | create `[bofid="btnNewResource"]`; build action `[key="KNOWLEDGE_GRAPH_BUILD"]`; validate `[bofid="btnValidate"]`; refresh `[bofid="btnRefresh"]` |
| AIChat | model selector `[qtp="ask-model-select-button"]`; editor `[qtp="chat-input-tiptap"] [contenteditable="true"]`; send `[qtp="chat-send-button"]`; running marker `[qtp="chat-stop-send-button"]` |
| Agent editor | add `[qtp="toolbar-btn-ADDNODE"]`; save `[qtp="toolbar-btn-SAVE"]`; run `[qtp="toolbar-btn-TEST"]`; publish `[qtp="toolbar-btn-DEPLOY"]`; published state exposes `[qtp="toolbar-btn-OFFLINE"]` |

Live behavior:

- Data-model and analysis creation often open new pages. Re-enumerate
  `context.pages()` and select by URL hash, not array index.
- A saved model can immediately create pivot/dashboard analyses from the
  follow-up dialog; dashboard title edits occur in the component property
  panel, not by replacing canvas text.
- Model-graph field checkboxes use `tree-checkbox0` (off) and `tree-checkbox1`
  (on). Select low-cardinality business dimensions, click `校验`, and require
  visible `校验通过` before confirming.
- After graph build, close the resource picker, refresh the list, and inspect
  the exact row for `成功`, build timestamp, and duration.
- AIChat may cache its model catalog. Refresh the picker and reload the AIChat
  page after a graph build; verify the exact model text before typing.
- AIChat completion is the disappearance of `chat-stop-send-button`, not a
  fixed sleep. Capture the answer table and reconcile its values independently.
- Agent nodes are `.agent_node`. The node palette may remain mounted at width
  zero; open/close it through the toolbar and never assume absence from the DOM
  means absence from the canvas.
- Agent prompt fields open a Mavon editor dialog. Edit the visible textarea,
  confirm, then save the graph. For the basic graph, bind the LLM variable to
  `会话变量 / 问句`; binding to Start output leaves the question empty.
- Agent execution success requires graph state `FINISH` and non-empty
  `dataagent/output/{llmNodeId-instanceId}`. A transient UI error dialog can
  race a completed backend run; treat the backend state/output as authoritative.
- CLI adapters `ui-open` and `ui-dashboard-check` first resolve the catalog
  resource through the authenticated API and refuse non-namespaced resources.
  The dashboard check requires a `SMARTBIX_PAGE`, a redirected Smartbix URL,
  visible chart output, and non-empty page text.

## Error Recovery

| Symptom | Recovery |
|---|---|
| CDP connection refused | Confirm Chrome process and port 9222; do not launch a second profile owner |
| Login form visible | Authenticate only from the configured credentials file; never emit field values |
| Locator missing | Verify current page, tab, dialog, and exact visible label |
| Locator duplicated | Scope to panel/dialog/folder; do not choose arbitrary first match |
| Click waits indefinitely | Check overlay and new-tab behavior; use `noWaitAfter` only with an explicit subsequent state check |
| Sidebar title selector fails | Use scoped sidebar container plus exact text pattern |
| ETL red node | Open that node's log, capture safe error, inspect type/expression/input |
| Output table creation fails | Verify primary key, name collision, target data source, and permissions |
| Model totals inflate | Recheck grain, join fields, cardinality, and many-to-many paths |
| AIChat has no model | Verify model graph completed and correct resources were selected |
| AI answer differs from pivot | Recheck selected model, metric aggregation, filters, and graph field semantics |
| Agent gets an empty question | Rebind the LLM input variable to `会话变量 / 问句`, save, and rerun |
| Agent publish button disappears | Check for `状态：已发布`, `toolbar-btn-OFFLINE`, and the deployment relation |

## Sensitive Output Controls

Never emit:

- username/phone shown in the header;
- password field values, cookies, local/session storage, authorization headers, or request bodies containing credentials;
- unredacted screenshots of account header or sensitive tables;
- raw personal, health, education, financial, or behavioral data.

Prefer structured safe output:

```json
{
  "state": "workspace",
  "module": "数据准备",
  "marker": "自助ETL",
  "artifact": "<non-sensitive resource name>",
  "status": "success"
}
```

When a screenshot is necessary, crop to the task panel and redact identifiers before showing or storing it.
