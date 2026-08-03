# Live-Demo Skript – AeroLift Agentforce Grounding

> **Hinweis:** Dieses Skript ist ein Template. Frage-IDs in Akt 2/3 nach dem
> ersten Eval-Lauf einsetzen, nicht vorab raten. Eval-Output unter
> `eval/results/run-<timestamp>.md` zeigt, welche Fragen die stärksten
> Kontraste liefern.

## Setting

- 18 Minuten, Konferenz/Kunde
- Architektur-Publikum (technisch, nicht reiner Vertrieb)
- Demo-Org: dedizierte Dev-Sandbox `aerolift-demo`
- Beide Agents (`AeroLift_Agent_A`, `AeroLift_Agent_B`) im Builder-UI offen, Tabs vorbereitet

---

## Akt 1 – Setup (3 Min)

- **Slide 1: Kontext**  AeroLift Industries, fiktiver Pumpenhersteller, AL-3000- und AL-3500-Reihe mit eng verwandten Varianten. Domäne ist bewusst so gewählt, dass Standard-Chunking-Strategien Schwierigkeiten haben (Tabellen, ähnliche IDs, Multi-Kriterien).
- **Slide 2: Disclaimer**  Modellnummern, Spec-Werte, Zertifikate sind erfunden. ATEX-Zertifikatsnummern folgen dem Schema der DEKRA EXAM, sind aber fiktiv.
- **Slide 3: Architektur**  Architektur-Diagramm aus `eval/results/comparison-en.html` zeigen. Drei Pfade: Variante A (Data Library), B-naive (Hybrid Search ohne Pre-Filter), B-boosted (Hybrid Search + ID-Pre-Filter auf Modell-IDs).
- **Aussage**: „Wir testen, was Pre-Processing + Hybrid Search + ID-Pre-Filter wirklich beitragen. Drei Bedingungen, gleicher System-Prompt, gleiche Quelldaten."

---

## Akt 2 – Variante A (5 Min)

Drei Fragen aus dem Eval, die typische A-Failure-Modes zeigen.

> **Auswahl-Anweisung:** Aus dem Eval-Lauf drei IDs nehmen, die A=FAIL und
> B-boosted=PASS zeigen. Idealerweise:
> - Eine **factual-precise mit Tabellen-Failure** (Q03 oder Q09)
> - Eine **multi-criteria** (Q06, Q07 oder Q10)
> - Eine **id-disambiguation** (Q14 oder Q15)

| Slot | Frage-ID (nach Eval einsetzen) | Failure-Mode benennen |
|---|---|---|
| 1 | _____ | _____ |
| 2 | _____ | _____ |
| 3 | _____ | _____ |

Pro Frage:

1. Frage live im Agent A UI eingeben.
2. Antwort vorlesen.
3. Failure-Mode klar benennen ("Tabelle wurde beim Default-Chunking zertrennt", "ID-Verwechslung wegen ähnlicher Embeddings", "Negation in Multi-Kriterien-Frage nicht erkannt").
4. Nicht entschuldigen oder relativieren – das ist der Punkt, den die Demo zeigt.

---

## Akt 3 – Variante B (5 Min)

Gleiche drei Fragen, gleiche Reihenfolge, jetzt im Agent B UI.

Pro Frage:

1. Frage live in Agent B eingeben.
2. Antwort vorlesen, mit A vergleichen.
3. Bei mindestens einer Frage: das `diagnosticInfo`-Feld aus dem Apex-Retriever zeigen
   (im Agent-Builder unter dem Action-Tab oder via Anonymous Apex).
   Beispiel: `Boost applied: filter on product IDs (AL-3000-SX)`.
4. Architektur-Erklärung mit dem Diagramm zurückbinden:
   - Pre-Processing zerlegt Tabellen in atomare Records mit Metadaten-Feldern.
   - Hybrid Search kombiniert BM25 (lexikalisch) und Embedding (semantisch).
   - ID-Pre-Filter: erkannte Modell-IDs werden als `productIds__c` Pre-Filter
     in den `hybrid_search()`-Aufruf gegeben, **bevor** das Fusion-Ranking läuft.

---

## Akt 4 – Wahrheit (3 Min)

- **Eval-Übersichtstabelle** aus `eval/results/run-*.md` zeigen.
- Drei Kernaussagen:
  1. **A vs. B-boosted (Antwort)**: B liefert in der Mehrheit der Fragen die korrekte Antwort, wo A scheitert.
  2. **B-naive vs. B-boosted (Retrieval)**: der ID-Pre-Filter trägt messbar bei – isolierter Effekt der lexikalischen Komponente.
  3. **Latenz-Trade-off**: B ist nicht schneller. Vorteil ist Antwort-Qualität, nicht Speed. Bei Frage-Komplexität ist die Latenz-Differenz sekundär.
- **Ehrliche Grenze**: Bei den fair-winnable Fragen (Q02, Q04, Q05) liefert A genauso gute Antworten. Demo ist kein Strohmann.

---

## Akt 5 – Takeaway (2 Min)

**Entscheidungs-Heuristik: wann Library, wann Custom?**

| Situation | Empfehlung |
|---|---|
| Reine FAQ / Wissens-Artikel, wenig Tabellen | Data Library reicht |
| Spec-Sheets, technische Tabellen | Custom Vector Search lohnt |
| Eng verwandte IDs / SKUs / Modellnummern | Hybrid + ID-Pre-Filter ist Pflicht |
| Multi-Kriterien-Anfragen mit strukturierten Filtern | Custom + Metadaten-Felder |
| Hohe Latenz-Anforderung (< 2s) | Library, weniger Hops |

**Repo-Verweis**: GitHub-Link, README, Architektur-Diagramm.

---

## Anti-Patterns / häufige Einwürfe

| Einwurf | Antwort-Skizze |
|---|---|
| "Aber B ist langsamer" | Ja, ~5s vs. 4.5s. Bei Frage-Komplexität nicht entscheidend. Wenn Latenz Priorität hat, andere Architektur-Wahl. |
| "Aber das ist viel mehr Code" | Korrekt: ~250 Zeilen Apex + Pre-Processing-Skript. Trade-off bewusst, nicht für jeden Use-Case sinnvoll. |
| "Hat das nicht ein Hyperscaler-Pendant?" | Ja, jeder Vector-DB-Anbieter. Salesforce-Wert ist Same-Org-Setup ohne externen Callout, native CRM-Integration. |
| "Embedding-Modell ist anders" | Nein, Embedding ist identisch. Unterschied ist Pre-Processing + Hybrid-Search + ID-Pre-Filter. |
| "Funktioniert das mit englischen Dokumenten?" | Pre-Processing-Logik ist sprach-agnostisch (AST-Tabellen-Parser). Embedding-Modell handled DE/EN. |

---

## Backup

- **MP4-Aufzeichnung** der Smoke-Tests bereithalten unter `docs/backup-eval-run.mp4`.
- Wenn Live-Demo wackelt (Org-Latenz, Agent-Verfügbarkeit, Netzwerk): Switch auf Aufzeichnung mit Voice-Over.
- Eval-JSON `eval/results/run-<timestamp>.json` als Datei-Beleg dabei haben, falls nach konkreten Zahlen gefragt wird.

---

## Pre-Demo-Checkliste

- [ ] Beide Agents in Builder-UI offen, Status `Active`
- [ ] Drei Frage-IDs aus letztem Eval-Lauf in Akt 2/3 eingetragen
- [ ] Eval-Markdown unter `eval/results/run-*.md` aktuell und im Browser-Tab geöffnet
- [ ] Architektur-Diagramm (`eval/results/comparison-en.html`) in einem zweiten Browser-Tab gerendert
- [ ] Audio + Bildschirm-Sharing getestet
- [ ] Backup-MP4 lokal verfügbar
