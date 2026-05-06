# DEPLOY.md – AeroLift Grounding Demo Runbook

Step-by-Step für die Live-Demo. Jeder Schritt nennt Klick-Pfad, Eingabewert
und Erwartungswert. Screenshot-Platzhalter zeigen, wo später eigene
Screenshots eingefügt werden können.

> **Hinweis zur Org-Sicherheit:** Diese Demo wird ausschließlich in einer
> dedizierten Demo-/Dev-Sandbox aufgesetzt – nicht in einer kunden-benannten
> Sandbox.

---

## 1. Voraussetzungen

| Komponente | Version | Prüfbefehl |
|---|---|---|
| Salesforce Org mit Agentforce + Data Cloud Lizenzen | Spring '26 oder neuer | UI: Setup → Company Information |
| `sf` CLI authentifiziert | ≥ 2.118 | `sf --version` |
| Pandoc + xelatex (Schritt 3.1) | – | `which pandoc && which xelatex` |
| Node.js | ≥ v23 | `node --version` |

```sh
sf org login web --alias aerolift-demo
sf org display --target-org aerolift-demo
```

Erwartung: Org-Domain wird angezeigt (z. B. `https://orgfarm-….my.salesforce.com`).
Die Domain wird in Schritt 6a benötigt.

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

![Screenshot: Konsole mit erfolgreichem preprocess-Lauf](docs/screenshots/02-preprocess-output.png)

---

## 3. Salesforce-Metadaten deployen

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
- `Tests: 6 passed, 0 failed`
- Coverage `ProductIndexRetriever`: ≥ 85 %.

Häufige Fehler:
- `Variable does not exist: AiCopilot__ReAct` → siehe `[Inference]`-Liste in der README; den `plannerType`-Wert auf den in der eigenen Org sichtbaren ersetzen (Setup → Agentforce → Planners).
- `Cannot find type EinsteinServiceAgent` → analog für den Bot-`<type>` (siehe Bot-Datei).
- `Variable does not exist: GenAiPlannerBundle` → Org-API-Version unter v64.0 oder ältere Release. Ziel-API auf v64.0+ heben oder die Bundles temporär aus dem Deploy-Set ausschließen.

![Screenshot: erfolgreicher sf-Deploy](docs/screenshots/03-deploy-success.png)

---

## 4. Data Cloud konfigurieren (UI)

> **Voraussetzung:** Data Cloud muss in der Org aktiviert und provisioniert sein,
> bevor Data Libraries oder Search Indexes anlegbar sind. Verifizieren über
> Setup → Data Cloud → Setup Home → Status `Provisioned`. Falls nicht: Aktivierung
> und Workspace-Anlage zuerst durchführen, ggf. mit Salesforce-Account-Team.

### 4a. DLO `AeroLift_Document_Chunk__dll` erstellen

Setup → Data Cloud → Data Lake Objects → New.

| Feld | Wert |
|---|---|
| Label | AeroLift Document Chunk |
| API Name | `AeroLift_Document_Chunk__dll` |
| Category | Other |
| Primary Key | `recordId` |

Felder anlegen entsprechend `data-cloud/metadata/dlo/AeroLift_Document_Chunk.dlo.yaml`. Schneller Weg: das YAML als Single-Source-of-Truth offen halten und Feld für Feld übernehmen.

Erwartung: 15 Felder, davon ein Primary Key, drei Picklists, drei Boolean/Number-Mischtypen.

![Screenshot: DLO mit allen Feldern](docs/screenshots/04a-dlo-fields.png)

### 4b. CSV-Ingestion

Pro Datei in `data-cloud/csv/`:

1. Setup → Data Cloud → Data Streams → New → CSV Upload.
2. CSV hochladen (z. B. `product-catalog.csv`).
3. Mapping: Source-Header 1:1 auf DLO-Feldnamen.
4. Multi-Value-Behandlung für `productIds`: als Text mit Trennzeichen `;`.
5. Run.

Wiederholung für alle acht Quell-CSVs. Alternativ einmalig `all-records.csv`.

Erwartung pro Stream: Status `Successful`, Row-Count = Record-Count laut Konsolen-Summary aus Schritt 3.2.1 (insgesamt 164 Records).

![Screenshot: CSV-Mapping-Dialog](docs/screenshots/04b-csv-mapping.png)

### 4c. DMO `AeroLift_Document_Chunk__dlm` mappen

Setup → Data Cloud → Data Model Objects → New (oder existing).

- Quelle: `AeroLift_Document_Chunk__dll`
- Mapping: Identity-Mapping (1:1 auf alle Felder, siehe `data-cloud/metadata/dmo/AeroLift_Document_Chunk.dmo.yaml`).

Erwartung: DMO `AeroLift_Document_Chunk__dlm` ist verfügbar, Feld-Profil zeigt 15 Felder.

### 4d. Search Index erstellen

Setup → Data Cloud → AI Search → Search Indexes → New.

| Feld | Wert |
|---|---|
| Label | AeroLift Document Chunk – Hybrid Index |
| API Name | `AeroLift_Document_Chunk_Idx` |
| Source DMO | `AeroLift_Document_Chunk__dlm` |
| Text Field | `content` |
| Mode | **Hybrid** (lexical + semantic) |
| Embedding Model | Salesforce-managed Default |
| topK | 8 |

Filterable Metadata Fields (in dieser Reihenfolge aktivieren):
- `productIds`
- `docType`
- `atexZone`
- `tempMaxC`
- `foerderleistungM3h`
- `ex_certified`

Return Fields:
- `recordId`, `sourceFile`, `sourceSection`, `content`, `productIds`, `docType`

![Screenshot: Search-Index-Konfiguration](docs/screenshots/04d-search-index.png)

### 4e. Indexing-Job triggern

Save → Build Index.

Erwartung: Status `Building` → `Ready` nach ca. 10–20 Minuten für 164 Records (org-lastabhängig). Abbruch nicht akzeptabel; bei Fehler im Job-Log nachsehen, häufig sind es Encoding-Probleme oder fehlende Pflichtfelder.

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

In der Library: Upload → die acht PDFs aus `content/pdf/` auswählen.

Erwartung: Pro PDF ein Eintrag, Status zunächst `Indexing`, danach `Ready`.
Beim Indexieren erzeugt Data Cloud automatisch im Hintergrund:

- einen Library-Search-Index,
- einen Standard-Retriever,
- die Standard-Action **`AnswerQuestionsWithKnowledge`** (in Spring '26;
  Name in der eigenen Org unter Setup → Agent Builder → Actions verifizieren).

Diese drei Komponenten sind **nicht** als eigene SFDX-Source-Dateien angelegt
und stehen nach Indexierung im Agent Builder zur Verfügung.

![Screenshot: Data Library mit acht Dokumenten](docs/screenshots/05b-library-uploaded.png)

### 5c. Library-Indexierung abwarten

Erwartung: alle acht Dokumente Status `Ready` (~5 Minuten).

### 5d. Agent A: Library an Topic anhängen + aktivieren

Setup → Agentforce → Agents → AeroLift Agent A (Data Library) → Open in Builder.

1. Topic `Produktwissen AeroLift` öffnen.
2. Im Topic die Action **`Answer Questions with Knowledge`** (oder den release-aktuell
   gültigen Standard-Namen) hinzufügen, im Konfigurations-Dialog die Library
   `AeroLift_Produktwissen` auswählen.
3. Save → Activate Agent.

Erwartung: Agent erreichbar, Status `Active`. Die Topic-XML im Repo referenziert
die Action bereits als `AnswerQuestionsWithKnowledge`; falls beim Deploy ein
Validation-Fehler kommt, Element entfernen und Action ausschließlich im Builder
hinzufügen.

---

## 6. Variante B einrichten

Variante B nutzt einen Same-Org Apex-Aufruf via `ConnectApi.CdpQuery.queryAnsiSqlV2`.
Es ist **kein** Named Credential, External Credential oder Self-Callout-Setup
erforderlich.

### 6a. Apex-Retriever per Anonymous Apex testen

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
- `diagnosticInfo` enthält `Boost applied: filter on product IDs [AL-3000-SX]`.
- Mindestens ein `results`-Eintrag mit `productIds` = `"AL-3000-SX"`.
- `content` des Top-Hits enthält `"150 °C"`.

Falls `diagnosticInfo` mit `ERROR:` beginnt:
- `INVALID_TYPE` / `Object 'AeroLift_Document_Chunk_index__dlm' not found` → Search-Index aus Schritt 4d/4e ist noch nicht `Ready` oder hat einen anderen DLM-Namen. Konstante `INDEX_DLM_NAME` in `ProductIndexRetriever.cls` an den tatsächlichen Namen anpassen.
- `INSUFFICIENT_ACCESS` → User hat keine Data-Cloud-Query-Permission. Standard-Permission-Set "Data Cloud Query" oder ein orgspezifischer Permission Set zuweisen.

![Screenshot: Anonymous Apex Debug Log mit Treffer](docs/screenshots/06a-apex-debug.png)

### 6b. Agent B aktivieren

Setup → Agentforce → Agents → AeroLift Agent B (Vector Search) → Activate.

Erwartung: Agent erreichbar, Topic ruft `AeroLift_Vector_Search_Boosted` (gemappt
auf `ProductIndexRetriever`) auf.

---

## 6.5. External Client App für den Eval-Harness anlegen

Der Eval-Harness in `scripts/eval/` ruft die Agent Runtime API und die Apex-REST-
Wrapper über OAuth 2.0 Client Credentials Flow auf. Dafür wird eine **External
Client App (ECA)** angelegt – die klassische Connected App mit User-Login passt
hier nicht.

### 6.5a. ECA anlegen (UI)

Setup → App Manager → New Connected App → **External Client App**.

| Feld | Wert |
|---|---|
| Name | `AeroLift Eval Harness` |
| API Name | `AeroLift_Eval_Harness` |
| Contact Email | (Demo-Admin) |
| Description | OAuth Client Credentials für den Eval-Harness aus `scripts/eval/` |

Unter **OAuth Settings**:

- ✅ Enable Client Credentials Flow
- ✅ Issue JWT-based access tokens for named users
- Callback URL: `https://login.salesforce.com/services/oauth2/callback` (für Client Credentials irrelevant, Feld ist Pflicht)

Scopes (alle drei sind erforderlich, siehe sf-ai-agentforce-testing/eca-setup-guide):

- `api` – generelle API-Calls (Apex REST)
- `chatbot_api` – Agent Runtime API
- `sfap_api` – Salesforce API Platform für Agent Runtime
- `refresh_token, offline_access` (empfohlen)

### 6.5b. Run-As-User setzen

App-Detail → Policy → Edit:

- ✅ Enable Client Credentials Flow
- Run As (Username): Demo-User mit Zugriff auf beide Agents und Apex-Klasse `RetrieverRestEndpoint` (System Administrator funktioniert; Least-Privilege bevorzugt).

### 6.5c. Consumer Key + Secret holen

App-Detail → Manage Consumer Details → (E-Mail-/SMS-Bestätigung) → Werte kopieren.

### 6.5d. Agent IDs notieren

Setup → Agent Builder → Agent öffnen → API Name oder ID kopieren (Format `0XxQ…`).

### 6.5e. `.env` anlegen

Im Repo-Root:

```sh
cp .env.example .env
$EDITOR .env   # Werte aus 6.5c und 6.5d eintragen, ANTHROPIC_API_KEY ergänzen
```

`.env` wird **nicht** committed (Gitignore-Eintrag in eigener Initiative empfohlen).

### 6.5f. Smoke-Test des Harness ohne LLM-Judge

```sh
npm install
node scripts/eval/run-eval.ts --skip-judge --only Q01,Q02
```

Erwartung: zwei Zeilen Eval-Output, kein OAuth-Fehler. Bei `401`/`403`: Scopes
oder Run-As-User in 6.5a/b prüfen.

---

## 7. Smoke-Tests vor der Demo

Wahlweise:

- **Manuell** über die Agent-Builder-Test-Konsole (siehe Tabelle unten).
- **Automatisiert** über den Eval-Harness (`npm run eval` oder mit `--only`-Filter
  als Stichprobe). Der Harness liefert maschinenlesbare JSON-/Markdown-Reports
  unter `eval/results/run-<timestamp>.{json,md}` – bevorzugt für reproduzierbare
  Demo-Vorbereitung.

Manuelle Stichprobe:

Drei Live-Fragen pro Agent durchspielen:

| ID | Frage | Erwartung A (Library) | Erwartung B (Vector + Boost) |
|---|---|---|---|
| Q01 (factual-precise, ID-Disambiguation) | "Welche maximale Medientemperatur hat die AL-3000-SX?" | Häufig 120 °C (verwechselt mit AL-3000-S) | 150 °C, mit Beleg aus `product-catalog.md` |
| Q06 (multi-criteria) | "Welche Pumpe ist ATEX Zone 1 zertifiziert und liefert mindestens 120 m³/h?" | AL-3000-SX (falsch, nur 80 m³/h) oder unsicher | AL-3500-HT-X mit Begründung |
| Q14 (id-disambiguation) | "Für welche ATEX-Zone ist die AL-3000-S zertifiziert?" | Häufig Zone 1 (verwechselt mit -SX) | Zone 2, mit Beleg aus `atex-guide.md` |

Beide Agents in der Agent Builder Test-Konsole testen, Antworten als Backup-Screenshots ablegen unter `docs/screenshots/07-smoketest-*.png`.

---

## 8. Demo-Tag-Checkliste

**T-30 Minuten**
- Beide Agents einzeln pingen (einmal pro Smoke-Test-Frage).
- Network-Latenz prüfen: Antworten innerhalb < 15 s.

**T-15 Minuten**
- Backup-Aufzeichnung der Smoke-Tests öffnen (Live-Demos können kippen, dann Screen-Recording einspielen).
- Browser-Profil ohne Erweiterungen verwenden, um Renderingprobleme zu vermeiden.

**Q&A-Vorab-Antizipation**

| Einwurf | Antwort-Skizze |
|---|---|
| "Ist B nicht einfach besser, weil ihr ein anderes Modell nutzt?" | Embedding-Modell ist identisch. B gewinnt durch Pre-Processing + Hybrid-Filter. Eval-Frageset zeigt das pro Kategorie. |
| "Funktioniert das auch mit englischen Dokumenten?" | Pre-Processing-Logik ist sprach-agnostisch (AST-Tabellen-Parser). Embedding-Modell handled DE/EN. Multi-Sprach-Demo wäre Folge-Iteration. |
| "Was passiert bei Updates der Quelldokumente?" | `node scripts/preprocess.ts` regeneriert Records deterministisch (recordId hängt an Datei + Section + Row); CSV neu hochladen. Keine manuellen Mapping-Schritte. |

---

## Anhang: Komplette Re-Run-Checkliste

Bei kompletter Neuanlage in einer frischen Demo-Org:

```sh
# 1. Build
./scripts/build-pdfs.sh
node scripts/preprocess.ts

# 2. Deploy
sf project deploy start --source-dir force-app/main/default \
  --test-level RunSpecifiedTests --tests ProductIndexRetrieverTest

# 3. UI-Setup laut Abschnitten 4–6
```

Alles, was in Abschnitten 4–6 als UI-Schritt beschrieben ist, lässt sich in der aktuellen Release nicht via `sf project deploy` automatisieren – siehe `[Inference]`-Liste in der README.
