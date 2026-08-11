# Smartbi Insight V11 Official SDK and Live HTTP API Reference

> Status: verified against a Smartbi Insight V11 tenant; host and account details are intentionally omitted.
> Endpoints span `/smartbi/vision/`, `/smartbi/smartbix/api/`, and `/smartbi/`.

## Source hierarchy and scope

Official Java API index: <https://wiki.smartbi.com.cn/api/javaapi/index.html>
(Javadoc metadata date: 2026-03-19).

Use that Javadoc as the source of truth for public Java SDK class names, method
signatures, parameter order, return types, and deprecation markers. It confirms
the central client contract used by this Skill:
`ClientConnector.remoteInvoke(classname, method, Object[])`.

The Javadoc is **not** a wire-protocol or complete Vision V11 REST reference.
It does not specify the `RMIServlet` encoding, `DataPackageServlet` import
actions, Smartbix `pages/beans` authoring payloads, ETL graph endpoints, or the
current AIChat training/query routes. Those contracts remain verified against
the configured live tenant and frontend bundles. Apply this evidence order:

1. official Javadoc for public SDK semantics and signatures;
2. live tenant request/response evidence for HTTP paths and payloads;
3. frontend bundle inspection only where the first two sources are silent.

Useful official cross-checks:

| Official class | Confirmed public contract | Skill relevance |
|---|---|---|
| `smartbi.sdk.ClientConnector` | `open`, `close`, `remoteInvoke`, `remoteMultipartInvoke`, `newRemoteInvoke`, `upload`, `download`, `setAccessToken` | Validates the session/client abstraction and class-method-parameter invocation shape |
| `smartbi.sdk.service.catalog.CatalogService` | `getCatalogElementById`, `getChildElements`, `getCatalogElementPath`, `isCatalogElementAccessible`, `createFolder`, `updateCatalogNode`, `copyAndPasteReturnNewId`, `deleteCatalogElement` | Authoritative catalog semantics; live frontend variants (`createFolderElement`, `moveCatalogElement`, `supportsCopy`, `copyAndPaste`) remain tenant-verified HTTP/RMI contracts |
| `smartbi.sdk.service.datasource.DataSourceService` | `getFields`, `getSampleTableData`, `getDataByQuerySql`, `execute`, `executeUpdate` | Field, preview, and reconciliation candidates; mutation still requires ownership guards |
| `smartbi.sdk.service.insight.ClientInsightService` | `createInsightQuery`, `openQuery`, `getInsightQuery`, `getRawReportData`, parameter methods | Official pivot-analysis lifecycle and result/parameter semantics |
| `smartbix.sdk.page.service.PageService` / `IPageClientService` | dashboard export and parameter definitions/values | Public SDK covers consumption, not dashboard authoring; `pages/beans` create/update remains live-verified |
| `smartbi.sdk.service.metadata.MetadataService` | `searchByReferenced`, `searchReferringTo` and recursive variants | Official lineage and impact-analysis capability for future guarded inspection |
| `AccessTokenUtil` + `ClientConnector.setAccessToken` | personal access-token generation and use | Potential passwordless setup when the target tenant exposes and authorizes it |

The current Javadoc exposes no modern AIChat graph/query contract:
`ClientAIService` contains only deprecated `autoUpdateLearning`. Continue to
validate AIChat routes from live network behavior and exact model receipts.


## 1. Transport: RMIServlet (all business calls)

```
POST /smartbi/vision/RMIServlet
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
Cookie: smartbi_smartbi_sessionid=...; JSESSIONID=...; ...
```

Request body is a single `encode` parameter:

```
encode=<SelectedCoder(encodeURIComponent(className) + "+" + encodeURIComponent(methodName) + "+" + encodeURIComponent(JSON.stringify(paramsArray)))>
```

Response is decoded with the same selected frontend coder contract:

```json
{"retCode": 0, "result": ..., "detail": ..., "duration": 55}
```

- `retCode === 0` → success.
- `retCode === "CLIENT_USER_NOT_LOGIN"` → session expired; re-login.
- `retCode === "METHOD_NAME_ERROR"` → wrong service/method name.

### Adaptive transport coder

`CodeHandler.js` selects one of three frontend coders through
`NETWORK_TRANSNISSION_ALGORITHM`:

- `SF1`: `ReplaceCoder`, a character substitution table;
- `SF2`: `ReplaceCoder` followed by hexadecimal escaping;
- `SF3`: `ReserveCoder`, an identity transform.

The CLI does not assume SF1. At process startup it fetches `CodeHandler.js` and
all three coder bundles from the configured tenant, parses their current
arrays/delimiters, validates structure, and hashes their complete contents.
It then negotiates the active algorithm with the read-only current-user probe.

The result is cached by base URL and SHA-256 fingerprint at
`~/.cache/smartbi-platform/transport-codec.json` (override with
`SMARTBI_CODEC_CACHE_FILE`). An unchanged live hash reuses the cache; a changed
hash replaces it. If discovery is offline, the last same-tenant cache is used,
then a fixed known-good fallback only when no cache exists. One transport parse
failure forces rediscovery and renegotiation; a second failure stops.

Important: the observed SF1 lookup is **not involutive**. The frontend's
`encode` and `decode` functions apply the same lookup, but
`decode(encode(sample))` is not a valid self-test. Validation therefore uses
structural permutation checks plus an actual low-risk server probe.

## 2. Session

| Sequence | Call |
|---|---|
| 1. Seed cookies | `GET /smartbi/vision/index.jsp` (no auth needed; returns `JSESSIONID`, `smartbi_smartbi_sessionid`) |
| 2. Login | `UserService.login` `[user, password]` → `result: true` |
| 3. Session probe | `AIextRemoteService.getCurrentUserName` `[]` → current user alias |

Credentials are read from a two-line current-user-owned regular file (line 1
account, line 2 password). Symlinks and any mode other than exact `0600` are
rejected on each read, and credential-backed login is HTTPS-only. Guided setup
creates this file; command output never contains either credential or the
authenticated account identifier. Smartbix and plain-JSON clients share one
bounded RESEND budget across codec attempts after a verified authentication
redirect/response. Exhausting that budget fails closed; browser mutation is not
used as a transport fallback.

## 3. Resource tree (catalog)

| Call | Params | Notes |
|---|---|---|
| `CatalogService.getChildElements` | `[parentId]` | Children of any node; parent `""` = root |
| `DataPackageModule.getChildElementsWithoutUnionDBChilds` | `[parentId, [typeFilter], "READ", false]` | Data-connection scoped listing |
| `CatalogService.getCatalogElementPath` | `[resourceId]` | Full ancestry used for personal-workspace and descendant-cycle checks |

Node shape: `{id, name, alias, type, hasChild, ...}`. Key root ids:

| id | alias | type |
|---|---|---|
| (empty) | 根 | - |
| `DATASOURCES` | 数据连接 | DATASOURCES |
| `DS.input` | 可导入数据库 | DATASOURCE |
| `SCHEMA.input.input.null` | input | SCHEMA |
| `I0bb03010c0184001` | 数据采集空间 | DEFAULT_TREENODE |
| `I0bb03010c0184001_<userNode>` | `<account alias>` | DEFAULT_TREENODE (personal) |
| `SELF_...` | 我的工作区 | SELF_TREENODE |

Personal acquisition folder under `可导入数据库 > input > 数据采集空间 > <account>`.

Folder creation uses `CatalogService.createFolderElement` with
`[parentId, name, alias, description, null, false, "DEFAULT_TREENODE.png"]`.
The CLI namespaces the name and verifies the saved child before returning.

Owned resource management uses the same live frontend calls as the resource-tree
menus, but without manual clicks:

| Operation | Live RMI call | Guarded verification |
|---|---|---|
| rename visible alias/description | `updateCatalogNode(id, JSON.stringify({alias,desc}), null)` | exact direct-child confirmation, namespace, `WRITE`, sibling collision check, saved alias reload; also supports a `BASETABLE` directly inside the authenticated personal acquisition folder |
| move | `moveCatalogElement(resourceId, targetParentId)` | source/target ownership, no descendant cycle, no collision, post-move absence/presence |
| copy non-folder | `supportsCopy(resourceId)`, then `copyAndPaste(targetParentId, sourceId, name, alias, desc)` | source `READ`, target `WRITE`, unique target name, saved child reload |
| copy folder | `createFolderElement`, then guarded recursive child copy | recursive rollback on child failure, final target reload |

The public Javadoc currently documents `copyAndPasteReturnNewId`, but the live
Vision frontend calls `copyAndPaste`; direct tenant verification showed that the
former is not exposed by this HTTP/RMI service. `changeAlias` appears in an
older tree bundle but is likewise unavailable; `updateCatalogNode` is the
verified mutation. The CLI therefore follows the live frontend contract and
uses Javadoc only for semantic cross-checking.

`catalog-audit` recursively reloads children and records `{id,parentId,name,
alias,type,path,namespaced}`. Resource moves or mass alias changes are complete
only when this manifest proves containment and no namespaced resource remains
outside the intended root.
Deletion uses `CatalogService.isCatalogElementAccessible(id, "DELETE")` then
`deleteCatalogElement(id)`. The CLI requires an exact parent-child match,
an approved parent scope, delete permission, and post-delete absence. Normal
resources must match the configured namespace by either physical name or alias.
For pre-namespace cleanup, `--confirm-name <exactName>` authorizes only a
`BASETABLE` directly inside the authenticated user's personal acquisition
folder; it never authorizes deletion from shared catalog folders.

## 4. File import chain (DataPackageServlet)

All requests `POST /smartbi/vision/DataPackageServlet` with session cookie.

### 4.1 UPLOAD_FILE — upload a local file

```
multipart/form-data
  field action = UPLOAD_FILE
  field file   = <binary>
```

Response: `{"retCode":0,"result":{"clientId":"I0c...","sheetNames":["0|sheet1|true", "..."],"fileName":"..."}}`
Keep `clientId` for all following steps. The CLI parses every returned worksheet
descriptor and requires one exact `--worksheet` selection whenever more than
one sheet exists; missing, duplicate, malformed, or ambiguous names fail.

### 4.2 GET_PREVIEW_DATA — inspect parsed columns

```
action=GET_PREVIEW_DATA&clientId=<id>&previewRows=30&sheetIndex=<selected-index>
```

Response `result`: `{rowCount, datas[][], fieldTypeList[], fieldNameList[], fieldAliasList[]}`.
`fieldTypeList` values seen: `STRING`, `INTEGER`, `DOUBLE`, `DATETIME`/`DATE`.
The CLI requires ordered non-blank unique headers, complete field types, and
rows that match the header width. It labels the preview row count separately
from terminal import evidence; it does not silently treat one as the other.

### 4.3 GET_TARGET_DATASOURCES — list importable data sources

```
action=GET_TARGET_DATASOURCES
```

Returns the same tree as `DS.input` walking (`可导入数据库` etc.).

### 4.4 INSERT_DATA — create table and import rows

```
action=INSERT_DATA&clientId=<id>&settings=<encodeURIComponent(JSON)>
```

Settings (verified live):

```json
[{
  "createTable": true,
  "sheetIndex": "<selected-index>",
  "headerRowIndex": 0,
  "fieldTypeList": ["STRING","INTEGER", ...],
  "dsId": "DS.input",
  "schemaId": "input",
  "catalog": "input",
  "folderId": "PERSONAL_NODE",
  "tableName": "TEAM_survey_demo",
  "tableAlias": "TEAM_survey_demo",
  "fieldAliasList": [...],
  "fieldNameList": [...],
  "importType": "REPLACE",
  "keepUniqueData": true,
  "fileName": "TEAM_survey_demo.csv",
  "primaryKeyIndexs": []
}]
```

Notes:
- `tableName` > 30 chars is truncated server-side; the CLI applies the namespace
  and platform limit deterministically before collision checks.
- Table/column names are normalized to lowercase in the physical table.
- `folderId: "PERSONAL_NODE"` places the table in the caller's personal
  acquisition space.
- The CLI never sends `REPLACE` directly against an unproven target. It first
  imports a distinct invocation-owned staging table, verifies exact ordered
  name/type schema and source digest, then imports the same bytes into the
  exactly confirmed target. Staging is deleted only after final postconditions;
  if target mutation fails, the proven staging table is preserved for recovery.

### 4.5 Import status polling

```
RMI DataPackageModule.getImportStatus [clientId]
```

Result `{retCode: 0, ...}` means done; non-zero means error detail.

### 4.6 DELETE_FILE — cleanup after abort

```
action=DELETE_FILE&clientId=<id>
```

## 5. Observed service inventory (partial)

| Service | Methods observed |
|---|---|
| `UserService` | `login`, `logout`, `refreshSession` |
| `AIextRemoteService` | `getCurrentUserName`, `getCookie` |
| `CatalogService` | `getCatalogElementById`, `getChildElements` |
| `DataPackageModule` | `getChildElementsWithoutUnionDBChilds`, `getImportStatus`, `clearImportStatus` |
| `ConfigClientService` | `getSystemConfig` (e.g. `AI_CHAT_ENABLE_V2`, `AI_CHAT_USE_NEW_VECTOR`), `addModuleVisitOperationLog2` |
| `TenantModule` | `getTenantUiEntryPermission` |
| `CompositeService` | `commpositeOpenBaseTaskPanelInvoke` |
| `DataPackageModule` | `getChildElementsWithoutUnionDBChilds` |
| `SessionLogService` | `flushUserLogs`, `addClientLog` |

## 6. Smartbix API

Base path: `/smartbi/smartbix/api/`. Use the same authenticated cookie jar.
Requests send `SMX-Encode: encode`; JSON POST bodies are ReplaceCoder-encoded.
Responses may be plain JSON or ReplaceCoder-encoded JSON, so decode both forms.

| Method and path | Purpose | Verified result |
|---|---|---|
| `GET datamining/flow/{flowId}/no` | Load a saved flow | wrapper with `processDag.define` JSON DAG |
| `GET datamining/nodes` | Load live ETL node templates, ports, and config contracts |
| `POST dataprocess/processflowdefine/define` | Save a changed DAG | saved flow metadata |
| `POST datamining/processflowdefine` | Start a run | execution `instanceId` |
| `GET datamining/flowstate/{instanceId}` | Poll execution | terminal `FINISH`/`ERROR`/`FAILED`/`KILLED` plus node states |
| `GET miningnode/portresult/{nodeId}-{instanceId}/{outputPortId}/csv` | Read terminal preview | fields/features and preview CSV |

The save/run body contains `processDag` plus `dagRemark`, `useCache` or
`toSaveTempDag`, and save flags. Preserve the server-returned `processDag`
metadata; only replace its serialized `define` when changing the graph.

Safety invariants implemented by `scripts/smartbi.mjs`: mutation and execution
refuse any flow whose saved name does not match the configured namespace.
Creation and execution that overwrite a materialized target require its exact
visible name. Competition mode rejects union creation and model cloning, and it
refuses a DAG unless every non-plumbing transform is a supported type with
substantive configuration explicitly recorded by `etl-insert`; default/unknown
nodes and no-op sampling do not count.
`etl-row-number` appends an `增加序列号` node only when the graph has exactly one
connectable sink, then saves through the endpoint above. `etl-node-list` exposes
live contracts. `etl-insert` inserts or updates a named unary transformation,
records the explicitly changed config keys, preserves target wiring, and marks
the graph `INITED`. Its `instanceKey` makes retries idempotent.

After a successful run, the CLI requires the returned instance to remain the
saved flow's exact current instance and every saved graph node state to be
successful. It reads a typed output-port preview immediately before the
materialized sink, reopens the exact source/target tables, and requires exact
ordered field-name/type identity before and after the run. The tenant exposes
no authoritative reopened target-row-count endpoint on this path, so the
receipt explicitly reports `reconciled:false`; preview row counts remain
source-labeled evidence, not a reconciliation claim.

### 6.1 Data models, analyses, dashboards, AIChat, and model graphs

The model/report/dashboard paths use the `/smartbi/smartbix/api/` base. Paths
beginning `cgi/` or `sdk/` below use the `/smartbi/` base and plain JSON.
Use `plain-get`/`plain-post` for guarded discovery and replay of the latter;
use `api-get`/`api-post` for Smartbix paths.

Competition analysis/dashboard creation, clone, and repair commands require
their source model, analysis, or dashboard to be a direct child of the same
candidate folder. Generic resource move/copy and model cloning are rejected.
Repair commands also require the exact current analysis/dashboard name.

| Method and path | Purpose |
|---|---|
| `GET augmentedDataSet/{id}` | Load a model with nodes, fields, measures, and views |
| `POST augmentedDataSet/{parentId}` | Create a model |
| `GET adhocanalysis/getReport/{id}` / `POST adhocanalysis/createReport?pid={parentId}` | Load/create pivot analysis |
| `POST adhocanalysis/updateReport` / `POST adhocanalysis/data/{id}` | Update and execute a pivot definition |
| `GET pages/beans?id={id}` / `POST pages/beans/create?pid={parentId}` | Load/create dashboard |
| `POST pages/beans?_method=PUT` | Update a dashboard; verified from the editor's Save request |
| `POST cgi/aichat-train/list-knowledge-graph-node` | List built/building model graphs |
| `POST cgi/aichat-train/get-resource-field-tree/{modelId}` | Resolve selectable, fully qualified graph field IDs |
| `POST cgi/aichat-train/validate_field_data_count/{modelId}` | Validate selected field cardinalities |
| `POST cgi/aichat-train/train-resource/{modelId}` | Start or rebuild a model graph |
| `POST cgi/aichat-train/get-trained-knowledge-graph-by-id/{modelId}` | Load one trained graph definition |
| `POST sdk/api/v1/aichat/conv/query-rpc` | Stream AIChat text/table/file artifacts |

Model/report/dashboard creation is implemented from live saved-resource
contracts. Model creation requires explicit measure specifications and exact
source tuples; relational creation additionally requires explicit relation
field, grain, cardinality, direction, and integrity metadata. Exact field IDs
and `refDataSetFieldId` values are fully qualified; do not fabricate bare IDs.
Analysis output is labeled `executionPreview`, and dashboard persistence is
deep-compared after reopen. Reconcile all generated values against an
independently validated aggregate.

Model-graph build contract:

```json
POST cgi/aichat-train/validate_field_data_count/<modelId>
{"fieldIds":["AUGMENTED_DATASET_FIELD.<modelId>.<qualified-field>"]}

POST cgi/aichat-train/train-resource/<modelId>
{"trainOption":{"resourceType":"AUGMENTED_DATASET","fields":["<qualified-field-id>"],"background":""}}
```

Poll `list-knowledge-graph-node` with statuses `SUCCESS`, `FAILED`, `BUILDING`,
and `PENDING`. The terminal state and selected fields are stored in the
returned node's JSON `extended` property. `scripts/smartbi.mjs` proves exact
direct-child ownership, resolves field names/IDs uniquely, validates count
provenance, rejects concurrent builds, and requires a newly observed terminal
success. An existing `SUCCESS` with the same fields is not freshness evidence;
pass `--rebuild` to start a new build. Competition additionally requires exact
current ETL lineage:

```bash
node scripts/smartbi.mjs aichat-graph-list TEAM_
node scripts/smartbi.mjs aichat-graph-fields <modelId>
node scripts/smartbi.mjs aichat-graph-build <parentId> <modelId> \
  survey_city,age_code --confirm-name <exactModelName> \
  [--etl-flow <flowId>] [--rebuild]
node scripts/smartbi.mjs aichat-graph-status <modelId>
```

Additional authenticated read routes observed live include
`get-recommend-questions/{modelId}`, `get-model-background/{modelId}`,
`get-link-llm-config/{modelId}`, `get-condition-format/{modelId}`,
`get-knowledge-base-by-id/{modelId}`, `get-knowledge-base/{modelId}`, and
`list-knowledge-edges/{modelId}` under `cgi/aichat-knowledge-graph-config/`.
Related save routes also exist, but their complete request/response
postconditions are not captured. The CLI therefore rejects recommended
questions, background, dynamic-column, and condition mutations rather than
guessing payloads.

### 6.2 Agent graph API

| Method and path | Purpose |
|---|---|
| `GET dataagent/getNodeOptions` | Live Agent node templates |
| `GET dataagent/graph/{id}` | Load graph, prompts, parameters, and metadata |
| `POST dataagent/graph/create/{parentId}` | Create an Agent resource |
| `POST dataagent/graph/update` | Persist graph edits |
| `POST dataagent/test/flow` | Start a test run |
| `GET dataagent/flow/nodestate/{instanceId}` | Poll run state and node states |
| `GET dataagent/output/{nodeId-instanceId}` | Read LLM result content and tokens |
| `GET dataagent/deploy/agent/{agentId}` | Read deployment relation |
| `POST dataagent/relation/create` | Publish `{id:null,agentId,resId:null}` |
| `DELETE dataagent/relation/offline/{agentId}` | Take an Agent offline |

The test body is `{query, queryType:"customagent_"+flowId,
currentInstanceId, flowId, convId}` with `convId === currentInstanceId`.
For the basic Start→LLM→Finish graph, bind the LLM variable named `question` to
`["sessionVar","query"]`; the Start node's custom field does not carry the
test-dialog question.


## 7. UI-only fallback (Playwright CDP)

Operations not yet exposed by a stable command (arbitrary visual canvas
editing and uncommon ETL transformations) require the browser:

- CDP endpoint `http://127.0.0.1:9222`, dedicated profile `/tmp/smartbi-playwright-profile-cdp`.
- API and browser maintain separate session cookies. Authenticate the headed
  profile from the configured credentials file only when its login page is
  visible; the dedicated profile then persists that browser session.
- See `references/playwright-patterns.md` for selectors and state machine.

## 8. Discovery method (how these were found)

1. Hook `XMLHttpRequest` in the console to capture `RMIServlet` call stacks →
   `freequery.common.util.remoteInvoke(className, methodName, params, cb)`.
2. Dump bundles via `gbk.jsp?name=vision/js/freequery/common/util.js` and
   `.../codeutil/ReplaceCoder.js` → recovered the encode table and the
   `encode=...` wire format.
3. Intercept `DataPackageServlet` posts while driving the UI upload flow →
   `UPLOAD_FILE` / `GET_PREVIEW_DATA` / `GET_TARGET_DATASOURCES` / `INSERT_DATA`.
4. Verify each call by replaying it from Node with a cookie jar (no browser).

Generic `invoke`, `api-post`, and `plain-post` commands are discovery/query
tools only. Paths are recursively decoded, canonicalized, and checked for
traversal, method overrides, and mutating verbs. Generic POST is allowlisted to
`datasets/table`, `adhocanalysis/data/<id>`, and
`cgi/aichat-train/validate_field_data_count/<id>`; artifact mutations must use
the ownership-checked dedicated commands.