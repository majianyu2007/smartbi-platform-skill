# Smartbi Insight V11 Reverse-Engineered API Reference

> Status: verified live against `smartbi.example.com` (2026-08-08).
> All endpoints are same-origin under `https://smartbi.example.com/smartbi/vision/`.

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

Credentials are read from a two-line file (line 1 account, line 2 password);
the tool never prints or stores the password.

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

## 6. UI-only fallback (Playwright CDP)

Operations not yet exposed via API (dashboard canvas editing, ETL node drag-drop,
AIChat graph construction) require the browser:

- CDP endpoint `http://127.0.0.1:9222`, dedicated profile `/tmp/smartbi-playwright-profile-cdp`.
- Login is done by the API tool first; the browser session then shares the same cookies.
- See `references/playwright-patterns.md` for selectors and state machine.

## 7. Discovery method (how these were found)

1. Hook `XMLHttpRequest` in the console to capture `RMIServlet` call stacks →
   `freequery.common.util.remoteInvoke(className, methodName, params, cb)`.
2. Dump bundles via `gbk.jsp?name=vision/js/freequery/common/util.js` and
   `.../codeutil/ReplaceCoder.js` → recovered the encode table and the
   `encode=...` wire format.
3. Intercept `DataPackageServlet` posts while driving the UI upload flow →
   `UPLOAD_FILE` / `GET_PREVIEW_DATA` / `GET_TARGET_DATASOURCES` / `INSERT_DATA`.
4. Verify each call by replaying it from Node with a cookie jar (no browser).
