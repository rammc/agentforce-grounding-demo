# DEPLOY.md – AeroLift Grounding Demo Runbook

Step-by-Step für die Live-Demo. Jeder Schritt nennt Klick-Pfad, Eingabewert
und Erwartungswert. Reihenfolge ist wichtig — viele Setups in Data Cloud sind
einbahnstraßenartig (Stream → DLO → DMO → Index).

> **Hinweis zur Org-Sicherheit:** Diese Demo wird ausschließlich in einer
> dedizierten Demo-/Dev-Sandbox aufgesetzt – nicht in einer kunden-benannten
> Sandbox.

---

## 1. Voraussetzungen

| Komponente | Version | Prüfbefehl |
|---|---|---|
| Salesforce Org mit Agentforce + Data Cloud Lizenzen | Spring '26 oder neuer | UI: Setup → Company Information |
| `sf` CLI authentifiziert | ≥ 2.118 | `sf --version` |
| Pandoc + xelatex (Schritt 2) | – | `which pandoc && which xelatex` |
| Node.js | ≥ v23 | `node --version` |

```sh
sf org login web --alias aerolift-demo
sf org display --target-org aerolift-demo
```

Erwartung: Org-Domain wird angezeigt (z. B. `https://orgfarm-….my.salesforce.com`).

---

## 2. Build-Pipeline (lokal)

```sh
# PDFs für Variante A
./scripts/build-pdfs.sh

# Records + CSVs für Variante B
node scripts/preprocess.ts
```

Erwartung:
- `content/pdf/*.pdf` enthält acht PDFs.
- `data-cloud/csv/all-records.csv` enthält alle 164 Records.
- Konsistenz-Check meldet `alle Spotchecks bestanden`.

---

## 3. Salesforce-Metadaten deployen (Apex + GenAi)

Der Initial-Deploy bringt Apex, GenAiFunction (Schema only), Topics und das
Permission Set in die Org. Agents/Bots werden NICHT als SFDX-Source deployed
(siehe README → Learnings → "Bot/BotVersion deploy is brittle").

```sh
sf project deploy start \
  --source-dir force-app/main/default \
  --target-org aerolift-demo \
  --test-level RunSpecifiedTests \
  --tests ProductIndexRetrieverTest \
  --wait 30
```

Erwartung:
- `Status: Succeeded`
- 9 Tests grün (inkl. `testExtractProductIdsRejectsReihenSuffix`)
- `ProductIndexRetriever` Coverage ~47 % — `ConnectApi.CdpQuery` ist nicht
  mockbar; Tests decken nur die deterministischen Bits ab.

### 3.1. Permission Set zuweisen

Wir haben in Schritt 6 später einen dedizierten Agent-Runtime-User. Vorher
muss ein normaler Demo-User Apex-Class-Access erhalten, falls jemand
`ProductIndexRetriever` anonym testen möchte.

```sh
sf org assign permset --name AeroLift_Agent_Access \
  --target-org aerolift-demo
```

Das Permission Set ist auf License `Einstein Agent` deklariert (für den
späteren Agent-Runtime-User). Für die manuelle Anonymous-Apex-Test in
Schritt 6.1 reicht das Apex-Recht des System Admins.

---

## 4. Data Cloud konfigurieren (UI)

> **Voraussetzung:** Data Cloud muss in der Org aktiviert und provisioniert
> sein. Verifizieren über Setup → Data Cloud → Setup Home → Status
> `Provisioned`. Falls nicht: erst Aktivierung und Workspace-Anlage.

> **Wichtig — Reihenfolge:** Data Stream → (erzeugt automatisch DLO) → DMO
> mappen → Search Index erstellen. Ein vorab manuell angelegtes DLO wird
> vom Data-Stream-Wizard NICHT wiederverwendet — der Wizard erzeugt sein
> eigenes DLO (1:1-Bindung). Spart Frust, wenn man das Stream-First angeht.

### 4a. Data Stream + DLO erzeugen

Setup → Data Cloud → Data Streams → New → CSV Upload.

1. CSV hochladen: `data-cloud/csv/all-records.csv`
2. Wizard fragt nach DLO-Name → eingeben:
   - Label: `AeroLift Document Chunk`
   - API Name: `AeroLift_Document_Chunk`
   - **Category: `Other`** (NICHT `Engagement` — sonst verlangt Salesforce
     ein Event-Time-Feld, das wir nicht haben)
3. Field Mapping:
   - Source-Header → DLO-Felder 1:1
   - **Keine `__c`-Suffixe in DLO-Feldnamen** (Salesforce-Validator lehnt
     Doppel-Underscores ab)
   - Erlaubte Typen: nur **Text / Number / DateTime**. Boolean → Text
     (`"true"`/`"false"`), Picklist → Text, LongTextArea → Text.
   - `productIds`: als Text mit Trennzeichen `;` (Multi-Value-String)
4. Run.

Erwartung:
- Stream-Status `Successful`
- 164 Records geladen (Konsistenz-Check aus Schritt 2)
- DLO `AeroLift_Document_Chunk__dll` ist sichtbar

### 4b. DMO mappen

Setup → Data Cloud → Data Model Objects → New (oder bestehendes mappen).

- Quelle: DLO `AeroLift_Document_Chunk__dll`
- Mapping: Identity-Mapping (1:1 auf alle Felder)

> **Achtung — DMO-Feld-Suffixe:** Die DMO-Schicht hängt automatisch `__c` an
> die Feldnamen an (z. B. `productIds` im DLO → `productIds__c` im DMO).
> Das ist anders als beim DLO und wirkt sich auf alle nachgelagerten
> SQL-Queries und Filter aus. Im Apex-Retriever entsprechend `productIds__c`
> referenzieren — `ProductIndexRetriever.cls` ist bereits darauf eingestellt.

### 4c. Search Index erstellen

Setup → Data Cloud → AI Search → Search Indexes → New.

| Feld | Wert |
|---|---|
| Label | AeroLift Document Chunk – Hybrid Index |
| API Name | `AeroLift_Document_Chunk_index` |
| Source DMO | `AeroLift_Document_Chunk__dlm` |
| Chunking Strategy | Single-Field, Field = `Chunk` |
| Embedding Model | Multilingual E5 Large (1024 dim, 512 token) |
| Mode | **Hybrid** (lexical + semantic) |
| topK | 5 (Default; per Query überschreibbar) |

**Pre-filter Fields** (genau in dieser Reihenfolge aktivieren — Salesforce
erlaubt bis zu 10 Felder pro Index, nur jetzt deklarierbar, nicht
nachträglich):
- `productIds__c`
- `docType__c`
- `sourceFile__c`
- `sourceSection__c`

**Return Fields:**
- `RecordId__c`, `sourceFile__c`, `sourceSection__c`, `productIds__c`, `docType__c`

> **Achtung — DLM-Naming:** Der Index erzeugt zwei virtuelle DLMs:
> - `AeroLift_Document_Chunk_index__dlm` (Index-Metadaten + Score-Spalten)
> - `AeroLift_Document_Chunk_chunk__dlm` (Chunk-Texte mit `Chunk__c`)
>
> Beide Namen sind in `ProductIndexRetriever.cls` als Konstanten festgehalten
> (`INDEX_DLM_NAME`, `CHUNK_DLM_NAME`). Falls der Index in deiner Org andere
> Suffixe vergibt, dort anpassen — nicht raten, sondern via Setup → Data
> Cloud → Data Model Objects nachschauen.

### 4d. Indexing-Job triggern

Save → Build Index.

Erwartung: Status `Building` → `Ready` nach 10–20 Minuten für 164 Records.
Bei `Failed`: ins Job-Log schauen (häufig Encoding oder fehlende Pflichtfelder).

### 4e. SQL-Smoke-Test

In Setup → Data Cloud → Query Editor:

```sql
SELECT "v"."hybrid_score__c", "c"."Chunk__c", "v"."productIds__c"
FROM hybrid_search(TABLE("AeroLift_Document_Chunk_index__dlm"),
                   'maximale Medientemperatur AL-3000-SX',
                   'productIds__c = ''AL-3000-SX'' OR productIds__c LIKE ''AL-3000-SX;%''',
                   5) AS "v"
INNER JOIN "AeroLift_Document_Chunk_chunk__dlm" AS "c"
       ON "c"."RecordId__c" = "v"."RecordId__c"
ORDER BY "v"."hybrid_score__c" DESC;
```

Erwartung: 5 Zeilen, Top-Hit enthält `150 °C`. Der Filter-String hat doppelte
Single-Quotes — das ist gewollt, weil hybrid_search() den Filter-Ausdruck als
String-Literal entgegen nimmt. Hybrid-Search-Filter unterstützen ausschließlich
Equality (`=`) und Prefix-LIKE (`X;%`); leitende Wildcards (`%X`),
`INSTR`, `CONTAINS`, `STARTS_WITH` werden NICHT akzeptiert.

---

## 5. Variante A einrichten

### 5a. Data Library erstellen

Setup → Agentforce → Data Libraries → New.

| Feld | Wert |
|---|---|
| Label | AeroLift Produktwissen |
| API Name | `AeroLift_Produktwissen` |
| Language | German |

### 5b. PDFs hochladen

Library öffnen → Upload → die acht PDFs aus `content/pdf/` auswählen.

Erwartung: Pro PDF ein Eintrag, Status zunächst `Indexing`, dann `Ready` (~5
Minuten gesamt).

Beim Indexieren erzeugt Data Cloud automatisch:
- einen Library-Search-Index,
- einen Standard-Retriever,
- die Standard-Action **`Answer Questions with Knowledge`** (in Spring '26).

Diese drei Komponenten sind **nicht** als SFDX-Source-Dateien angelegt und
stehen erst nach Indexierung im Agent Builder zur Verfügung.

### 5c. Agent A im Builder anlegen

Setup → Agentforce → Agents → New → Template **EinsteinServiceAgent**.

| Feld | Wert |
|---|---|
| Label | AeroLift Agent A (Data Library) |
| API Name | `AeroLift_Agent_A` |
| Language | English (Topics dürfen englisch sein, Antworten kommen in DE) |
| Topics | `Produktwissen AeroLift` (aus Schritt 3 deployed) |

Im Topic die Action **`Answer Questions with Knowledge`** hinzufügen, im
Konfigurations-Dialog die Library `AeroLift_Produktwissen` auswählen.

Activate Agent → Status `Active`. **Agent ID notieren** (Format `0Xx…`).

---

## 6. Variante B einrichten

Variante B nutzt einen Same-Org Apex-Aufruf via
`ConnectApi.CdpQuery.queryAnsiSqlV2`. Es ist **kein** Named Credential,
External Credential oder Self-Callout-Setup erforderlich.

### 6.1. Apex-Retriever per Anonymous Apex testen

Developer Console → Execute Anonymous:

```apex
ProductIndexRetriever.Request r = new ProductIndexRetriever.Request();
r.query = 'Welche maximale Medientemperatur hat die AL-3000-SX?';
r.topK = 5;
List<ProductIndexRetriever.Response> resps =
    ProductIndexRetriever.searchBoosted(new List<ProductIndexRetriever.Request>{ r });
System.debug(JSON.serializePretty(resps));
```

Erwartete Debug-Ausgabe:
- `diagnosticInfo`: `Boost applied: filter on product IDs (AL-3000-SX) | rowCount=5`
- Mindestens ein `results`-Eintrag mit `productIds = "AL-3000-SX"`
- `formattedContent` enthält `150 °C`

Falls `diagnosticInfo` mit `ERROR:` beginnt:
- `INVALID_TYPE` / `Object 'AeroLift_Document_Chunk_index__dlm' not found` →
  Search-Index aus 4c/4d ist nicht `Ready` oder hat einen anderen DLM-Namen.
  Konstante `INDEX_DLM_NAME` in `ProductIndexRetriever.cls` anpassen.
- `INSUFFICIENT_ACCESS` → User hat keine Data-Cloud-Query-Permission.
  Standard-Permission-Set `CDPAdmin` (Data Cloud Admin) oder
  `xDO_DataCloud_Base_PSG` zuweisen — siehe 6.4 für die Agent-Runtime-User-
  Konfiguration.

### 6.2. Agent B im Builder anlegen

Setup → Agentforce → Agents → New → Template **EinsteinServiceAgent**.

| Feld | Wert |
|---|---|
| Label | AeroLift Agent B (Vector Search) |
| API Name | `AeroLift_Agent_B` |
| Language | English |
| Topics | `Produktwissen AeroLift` (Topic_B aus Schritt 3) |

Topic öffnen → Action `AeroLift Vector Search (Boosted)` hinzufügen.

> **Wichtig:** Wenn das Topic bereits eine Funktion hatte (Re-Deploy etc.),
> kann eine stale `GenAiPluginFunctionDef`-Verknüpfung übrig bleiben, die
> einen sauberen Re-Deploy blockiert. Symptom: destructiveChanges-Deploy
> meldet `Generative AI Plugin Function Definition - 17EKY...`. Workaround:
>
> ```sh
> sf data query --use-tooling-api --query \
>   "SELECT Id, PluginId, Function FROM GenAiPluginFunctionDef \
>    WHERE Function='<funktion-id>'" --target-org aerolift-demo
> sf data delete record --use-tooling-api \
>   --sobject GenAiPluginFunctionDef --record-id <Id> --target-org aerolift-demo
> ```

Activate Agent → Status `Active`. **Agent ID notieren**.

### 6.3. Schema-Settings der Action prüfen

Im Builder → Topic → Action öffnen → Output-Section:

| Setting | Empfehlung |
|---|---|
| `Grounding Content` (formattedContent) → "Show in conversation" | OFF (für API-Konsumenten); ON für UI-Demo (Source-Panel sichtbar) |
| `Diagnostic Info` → "Show in conversation" | OFF |

> **Bekannte Einschränkung:** `copilotAction:isDisplayable: false` im
> `output/schema.json` wird vom UI-Override nicht respektiert. Die einzige
> verlässliche Steuerung läuft über das UI (View/Edit Action). Wenn du das
> UI nicht editieren kannst (read-only View), ist die Demo trotzdem sauber:
> für die Live-Demo ist "Show in conversation = ON" gewünscht (User sieht
> die Quellen). Für reine API-Konsumenten muss der Caller `result[]` aus
> dem Agent-Response selbst aggregieren — Beispiel siehe
> `scripts/eval/agents.ts`.

### 6.4. Permission Set für Agent-Runtime-User

Beim Agent-Anlegen erzeugt Salesforce automatisch einen Service-User
(z. B. `aerolift_agent_b@<orgdomain>.ext`). Dieser User braucht zwei
Permsets:

```sh
# 1. Apex-Class-Access (custom, in Schritt 3 deployed)
sf org assign permset --name AeroLift_Agent_Access \
  --on-behalf-of aerolift_agent_b@<orgdomain>.ext \
  --target-org aerolift-demo

# 2. Data Cloud Query Access (Standard-Permset)
sf org assign permset --name CDPAdmin \
  --on-behalf-of aerolift_agent_b@<orgdomain>.ext \
  --target-org aerolift-demo
```

Erwartung: keine "license doesn't match"-Fehler. Das custom Permset
deklariert License `Einstein Agent` — passend zum Agent-User-Profil.

> **Symptom ohne CDPAdmin:** Action liefert `result: []` und im Trace
> `diagnosticInfo: ERROR: System.NoAccessException: Insufficient
> Privileges: This feature is not currently enabled for this user.`

### 6.5. End-to-End-Test via Diagnostic-Script

```sh
node scripts/diag-agent.mjs <AGENT_B_ID> "Was ist die maximal zulässige Medientemperatur der AL-3000-SX?"
```

Erwartung im JSON-Response:
- `result[0].value.formattedContent` enthält 5 Quellen
- `result[0].value.diagnosticInfo`: `Boost applied: filter on product IDs (AL-3000-SX) | rowCount=5`

Falls `result: []`:
- Action nicht aufgerufen → Topic-GenAiFunction-Verknüpfung prüfen
  (`SELECT Id FROM GenAiPluginFunctionDef WHERE PluginId='<topic-id>'`)
- Agent-Version nicht aktiv → im Builder Deactivate → Activate
- **Wichtig:** Nach jeder Topic-/Action-Änderung Agent neu aktivieren.
  Aktive Versionen snapshotten die Konfig — neue Verknüpfungen greifen
  erst nach Reaktivierung.

---

## 7. External Client App (ECA) für den Eval-Harness

Der Eval-Harness in `scripts/eval/` ruft die Agent Runtime API über OAuth 2.0
Client Credentials Flow auf. Dafür wird eine **External Client App (ECA)**
angelegt – die klassische Connected App passt nicht.

### 7a. ECA anlegen

Setup → App Manager → New Connected App → **External Client App**.

| Feld | Wert |
|---|---|
| Name | `AeroLift Eval Harness` |
| API Name | `AeroLift_Eval_Harness` |
| Contact Email | (Demo-Admin) |

Unter **OAuth Settings**:

- ✅ Enable Client Credentials Flow
- Callback URL: `https://login.salesforce.com/services/oauth2/callback`

**Scopes** (genau diese drei):

- `api`
- `chatbot_api`
- `sfap_api`

> **Achtung:** Mehr Scopes (z. B. `refresh_token`, `offline_access`, `web`,
> `openid`) führen beim Token-Request zu `error: invalid_scope, message:
> too many scopes requested`. Salesforce akzeptiert für Client-Credentials
> nur den minimalen Set, den die App bei der Anlage konfiguriert hat —
> der `scope`-Parameter im Request wird ignoriert/abgelehnt.

### 7b. Run-As-User setzen

App-Detail → Policy → Edit:

- Run As (Username): User mit Zugriff auf beide Agents und das Permset
  `AeroLift_Agent_Access` (System Administrator funktioniert für die Demo)

### 7c. Consumer Key + Secret holen

App-Detail → Manage Consumer Details → (E-Mail-/SMS-Bestätigung) → Werte
kopieren.

### 7d. `.env` anlegen

Im Repo-Root:

```sh
cp .env.example .env
$EDITOR .env
```

```env
SF_INSTANCE_URL=https://<your-org>.my.salesforce.com
SF_CLIENT_ID=<consumer-key>
SF_CLIENT_SECRET=<consumer-secret>
AGENT_A_ID=0Xx...
AGENT_B_ID=0Xx...
ANTHROPIC_API_KEY=sk-ant-...   # nur für LLM-Judge; --skip-judge erlaubt leer
```

### 7e. Smoke-Test

```sh
npm install
npm run eval:smoke
```

Erwartung: 2 Zeilen Eval-Output, kein OAuth-Fehler.

---

## 8. Smoke-Tests vor der Demo

```sh
# Voller Eval-Run (15 Fragen × 4 Bedingungen)
npm run eval
```

Erwartung (Ausgangslage 2026-05-06):

| Bedingung | PASS |
|---|---|
| A (Data Library) | 12/15 |
| B-naive (Retrieval) | 13/15 |
| B-boosted (Retrieval) | **14/15** |
| B-boosted (Antwort, UI-View) | 12/15 |

Reports unter `eval/results/run-<timestamp>.{json,md}`.

Visualisierung: `eval/results/comparison-en.html` öffnen (oder
`comparison.html` für die deutsche Variante). Enthält Bar-Chart-Vergleich,
Heatmap pro Frage und Q13 als hervorgehobene Demo-Question.

---

## 9. Demo-Tag-Checkliste

**T-30 Minuten**
- Beide Agents pingen (`scripts/diag-agent.mjs <AGENT_ID> "<frage>"`)
- Browser-Tabs vorab öffnen: zwei Builder mit Conversation Preview, eine
  Tab auf `comparison-en.html`.

**T-15 Minuten**
- Sessions vorwärmen (Cold-Start kostet ~30 s)
- Backup-Aufzeichnung der Smoke-Tests griffbereit

**Demo-Fragen** (siehe `docs/demo-script.md`):
1. Q02 (Parität): "Welche Förderleistung hat die AL-3500?" → 140 m³/h
2. **Q13 (Differenzierer)**: "Welches Modell der AL-3000-Reihe ist für den
   Lebensmittelkontakt freigegeben und welche Zertifikatsnummer trägt
   seine ATEX-Zulassung?" → A vermisst die Cert-Nummer ("nicht angegeben"),
   B liefert `BVS 23 ATEX E 089 X` mit Quellen
3. Reserve Q03 (Tabellen-Chunking-Risiko)

---

## Anhang: Häufige Fallstricke (Quickref)

| Symptom | Ursache | Fix |
|---|---|---|
| DLO-Anlage: "Field name must not contain two consecutive underscores" | `__c`-Suffix in DLO-Feld | Suffix entfernen, der DLO macht keine `__c` |
| DLO-Anlage: "Engagement category requires Event Time field" | falsche Category | Category auf `Other` |
| `hybrid_search()` Foreign-Data-Source-Error | leitende Wildcard im Filter (`%X`) | nur `=` und `X;%` |
| Action-Output zeigt nur "Hier sind die Details..." | "Show in conversation" = ON | UI-Setting OFF, oder Caller aggregiert `result[]` selbst |
| `sf project deploy` "Unchanged" trotz lokaler Änderung am Schema | SFDX-Source-Tracking-Bug | Function via destructive deploy löschen, neu deployen, Topic-XML re-deployen |
| Agent: "doesn't have access to one or more reference actions" | Agent-User fehlt Apex-Class-Access | Permset `AeroLift_Agent_Access` zuweisen |
| Agent: `result: []`, Trace zeigt "NoAccessException" | Agent-User fehlt Data-Cloud-Query | Permset `CDPAdmin` zuweisen |
| Agent-Session-Create 404 "No valid version available" | Agent ist nicht aktiviert | Builder → Activate |
| OAuth: "too many scopes requested" | ECA hat zu viele Scopes | Scopes auf `api, chatbot_api, sfap_api` reduzieren |
| Permset-Assign: "user license doesn't match" | Permset hat falsche License | `<license>Einstein Agent</license>`; Permset löschen + neu erstellen (License nicht updatebar) |
| Action liefert phantome IDs (z. B. `AL-3000-R` aus "AL-3000-Reihe") | Regex matcht greedy | bereits gefixt: `(?![a-z])` Lookahead in `PRODUCT_ID_PATTERN` |

---

## Anhang: Komplette Re-Run-Checkliste

Bei kompletter Neuanlage in einer frischen Demo-Org:

```sh
# 1. Build
./scripts/build-pdfs.sh
node scripts/preprocess.ts

# 2. Deploy
sf project deploy start --source-dir force-app/main/default \
  --test-level RunSpecifiedTests \
  --tests ProductIndexRetrieverTest

# 3. UI-Setup laut Abschnitten 4–6 (Data Cloud, Library, Agents)

# 4. ECA + .env (Abschnitt 7)

# 5. Smoke-Test
npm run eval:smoke

# 6. Voller Eval-Run
npm run eval
```
