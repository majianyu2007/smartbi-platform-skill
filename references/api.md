# Smartbi Insight V11 Reverse-Engineered API Reference

> Status: verified live against `smartbi.example.com` (2026-08-09).
> Endpoints span `/smartbi/vision/`, `/smartbi/smartbix/api/`, and `/smartbi/`.

## 1. Transport: RMIServlet (all business calls)

```
POST /smartbi/vision/RMIServlet
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
Cookie: smartbi_smartbi_sessionid=...; JSESSIONID=...; ...
```

Request body is a single `encode` parameter:

```
encode=<ReplaceCoder(encodeURIComponent(className) + "+" + encodeURIComponent(methodName) + "+" + encodeURIComponent(JSON.stringify(paramsArray)))>
```

Response is the same ReplaceCoder-encoded JSON:

```json
{"retCode": 0, "result": ..., "detail": ..., "duration": 55}
```

- `retCode === 0` → success.
- `retCode === "CLIENT_USER_NOT_LOGIN"` → session expired; re-login.
- `retCode === "METHOD_NAME_ERROR"` → wrong service/method name.

### ReplaceCoder (SF1, default algorithm)

Character-by-character substitution via a fixed 128-entry table; the mapping is
involutive, so encode and decode use the same table. `/` and `%` pass through
unchanged. Full table + canonical implementation lives in
`scripts/smartbi.mjs` (verified round-trip against live server).

Other algorithms exist but are not active: SF2 HexadecimalCoder, SF3 ReserveCoder.
Selection is server-side via `NETWORK_TRANSNISSION_ALGORITHM` config (SF1 default).

## 2. Session

| Sequence | Call |
|---|---|
| 1. Seed cookies | `GET /smartbi/vision/index.jsp` (no auth needed; returns `JSESSIONID`, `smartbi_smartbi_sessionid`) |
| 2. Login | `UserService.login` `[user, password]` → `result: true` |
| 3. Session probe | `AIextRemoteService.getCurrentUserName` `[]` → current user alias |

Credentials are read from a two-line file (line 1 account, line 2 password).
Guided setup writes it with mode `0600`; command output never contains the
password. Smartbix and plain-JSON clients seed/login automatically when the
cookie jar is empty and retry exactly once after a login redirect or
`REDIRECT_TO_SMARTBI` response.

## 3. Resource tree (catalog)

| Call | Params | Notes |
|---|---|---|
| `CatalogService.getChildElements` | `[parentId]` | Children of any node; parent `""` = root |
| `DataPackageModule.getChildElementsWithoutUnionDBChilds` | `[parentId, [typeFilter], "READ", false]` | Data-connection scoped listing |

Node shape: `{id, name, alias, type, hasChild, ...}`. Key root ids:

| id | alias | type |
|---|---|---|
| (empty) | 根 | - |
| `DATASOURCES` | 数据连接 | DATASOURCES |
| `DS.input` | 可导入数据库 | DATASOURCE |
| `SCHEMA.input.input.null` | input | SCHEMA |
| `I0bb03010c0184001` | 数据采集空间 | DEFAULT_TREENODE |
| `I0bb03010c0184001_<userNode>` | 手机号 | DEFAULT_TREENODE (personal) |
| `SELF_...` | 我的工作区 | SELF_TREENODE |

Personal acquisition folder under `可导入数据库 > input > 数据采集空间 > <account>`.

Folder creation uses `CatalogService.createFolderElement` with
`[parentId, name, alias, description, null, false, "DEFAULT_TREENODE.png"]`.
The CLI namespaces the name and verifies the saved child before returning.
Deletion uses `CatalogService.isCatalogElementAccessible(id, "DELETE")` then
`deleteCatalogElement(id)`. The CLI also requires an exact parent-child match,
a configured namespace, and post-delete absence.

## 4. File import chain (DataPackageServlet)

All requests `POST /smartbi/vision/DataPackageServlet` with session cookie.

### 4.1 UPLOAD_FILE — upload a local file

```
multipart/form-data
  field action = UPLOAD_FILE
  field file   = <binary>
```

Response: `{"retCode":0,"result":{"clientId":"I0c...","sheetNames":["0|sheet1|true"],"fileName":"..."}}`
Keep `clientId` for all following steps.

### 4.2 GET_PREVIEW_DATA — inspect parsed columns

```
action=GET_PREVIEW_DATA&clientId=<id>&previewRows=30&sheetIndex=0
```

Response `result`: `{rowCount, datas[][], fieldTypeList[], fieldNameList[], fieldAliasList[]}`.
`fieldTypeList` values seen: `STRING`, `INTEGER`, `DOUBLE`, `DATETIME`/`DATE`.
`rowCount` includes the configured header row; CLI output subtracts that row
and reports imported data records.

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
  "sheetIndex": "0",
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
- `tableName` > 30 chars is truncated server-side with a warning dialog.
- Table/column names are normalized to lowercase in the physical table.
- `importType: "REPLACE"` overwrites an existing table with the same name.
- `folderId: "PERSONAL_NODE"` places it in the caller's personal acquisition space.

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

Safety invariant implemented by `scripts/smartbi.mjs`: mutation and execution
refuse any flow whose saved name does not match the configured namespace.
`etl-row-number` appends an `增加序列号` node only when the graph has exactly one
connectable sink, then saves through the endpoint above.
`etl-node-list` exposes those live contracts. `etl-insert` inserts or updates a
named unary transformation immediately before the single materialized target,
preserves the target wiring, and marks the graph `INITED`. Its `instanceKey`
makes retries idempotent; multi-input/output nodes remain explicit workflows
because their port semantics cannot be inferred safely.

### 6.1 Data models, analyses, dashboards, AIChat, and model graphs

The model/report/dashboard paths use the `/smartbi/smartbix/api/` base. Paths
beginning `cgi/` or `sdk/` below use the `/smartbi/` base and plain JSON.
Use `plain-get`/`plain-post` for guarded discovery and replay of the latter;
use `api-get`/`api-post` for Smartbix paths.

| Method and path | Purpose |
|---|---|
| `GET augmentedDataSet/{id}` | Load a model with nodes, fields, measures, and views |
| `POST augmentedDataSet/{parentId}` | Create a model |
| `GET report/{id}` / `POST report/{parentId}` | Load/create pivot analysis |
| `POST freequery/queryData` | Execute a pivot definition |
| `GET pages/beans?id={id}` / `POST pages/beans/create?pid={parentId}` | Load/create dashboard |
| `POST cgi/aichat-train/list-knowledge-graph-node` | List built/building model graphs |
| `POST cgi/aichat-train/get-resource-field-tree/{modelId}` | Resolve selectable, fully qualified graph field IDs |
| `POST cgi/aichat-train/validate_field_data_count/{modelId}` | Validate selected field cardinalities |
| `POST cgi/aichat-train/train-resource/{modelId}` | Start or rebuild a model graph |
| `POST cgi/aichat-train/get-trained-knowledge-graph-by-id/{modelId}` | Load one trained graph definition |
| `POST sdk/api/v1/aichat/conv/query-rpc` | Stream AIChat text/table/file artifacts |

Model/report/dashboard creation is implemented from live saved-resource
contracts. Exact field IDs and `refDataSetFieldId` values are fully qualified;
do not fabricate bare IDs. Reconcile generated analysis/dashboard values
against an independently validated aggregate.

Model-graph build contract:

```json
POST cgi/aichat-train/validate_field_data_count/<modelId>
{"fieldIds":["AUGMENTED_DATASET_FIELD.<modelId>.<qualified-field>"]}

POST cgi/aichat-train/train-resource/<modelId>
{"trainOption":{"resourceType":"AUGMENTED_DATASET","fields":["<qualified-field-id>"],"background":""}}
```

Poll `list-knowledge-graph-node` with statuses `SUCCESS`, `FAILED`, `BUILDING`,
and `PENDING`. The terminal state and selected fields are stored in the
returned node's JSON `extended` property. `scripts/smartbi.mjs` resolves field
names to IDs, validates cardinality before training, refuses non-namespaced
models, polls to `SUCCESS`, and skips an identical successful rebuild:

```bash
node scripts/smartbi.mjs aichat-graph-list TEAM_
node scripts/smartbi.mjs aichat-graph-fields <modelId>
node scripts/smartbi.mjs aichat-graph-build <modelId> survey_city,age_code
node scripts/smartbi.mjs aichat-graph-status <modelId>
```

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
- Login is done by the API tool first; the browser session then shares the same cookies.
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
