/**
 * Custom Retriever für die AeroLift-Grounding-Demo (Variante B).
 *
 * Ruft den Data Cloud Hybrid Search Index direkt im selben Org via
 * `ConnectApi.CdpQuery.queryAnsiSqlV2` auf. Kein HTTP-Callout, kein Named
 * Credential, kein External Credential erforderlich – das ist der idiomatische
 * Same-Org-Pfad seit Spring '26.
 *
 * Exponiert zwei InvocableMethods:
 *  - searchBoosted: Hybrid Search mit Lexikal-Boost auf Modell-IDs (Demo-B-Pfad).
 *  - searchNaive:   Hybrid Search ohne Boost-Logik (Eval-Baseline für Schritt 4).
 */
global with sharing class ProductIndexRetriever {
    // Erkennt AeroLift-Modell-IDs (AL-3000, AL-3000-S, AL-3000-SX, AL-3500, AL-3500-HT, AL-3500-HT-X).
    private static final Pattern PRODUCT_ID_PATTERN = Pattern.compile('AL-\\d{4}(?:-[A-Z]+)*');

    // [Inference] Search-Index-DLM-Name.  Beim Build eines Search Index in
    // Data Cloud wird ein virtuelles DLM mit dem Suffix '_index__dlm' erzeugt.
    // Der genaue Name ist durch die Index-Konfiguration in DEPLOY.md 4d
    // festgelegt; bei abweichendem Naming nur diese Konstante anpassen.
    private static final String INDEX_DLM_NAME = 'AeroLift_Document_Chunk_index__dlm';
    private static final String CHUNK_DLM_NAME = 'AeroLift_Document_Chunk_chunk__dlm';
    private static final Integer DEFAULT_TOP_K = 5;

    // ------------------------------------------------------------------
    // InvocableMethods
    // ------------------------------------------------------------------

    @InvocableMethod(
        label='AeroLift Product Search (Boosted)'
        description='Hybrid search with lexical boost on product IDs'
        category='Agentforce'
    )
    global static List<Response> searchBoosted(List<Request> requests) {
        return execute(requests, true);
    }

    // [Hinweis] Apex erlaubt nur eine @InvocableMethod pro Klasse, daher ist
    // searchNaive eine reguläre statische Methode.  Sie wird nicht von einem
    // Agent aufgerufen, sondern ausschließlich vom Eval-Harness via REST
    // (RetrieverRestEndpoint mit URL-Pfad /naive).
    global static List<Response> searchNaive(List<Request> requests) {
        return execute(requests, false);
    }

    // ------------------------------------------------------------------
    // Kernlogik
    // ------------------------------------------------------------------

    private static List<Response> execute(List<Request> requests, Boolean useBoost) {
        List<Response> responses = new List<Response>();
        if (requests == null) {
            return responses;
        }
        for (Request req : requests) {
            responses.add(executeOne(req, useBoost));
        }
        return responses;
    }

    private static Response executeOne(Request req, Boolean useBoost) {
        Response resp = new Response();
        resp.results = new List<SearchResult>();

        if (req == null || String.isBlank(req.query)) {
            resp.diagnosticInfo = 'Empty query, no search executed.';
            return resp;
        }

        Integer topK = (req.topK != null && req.topK > 0) ? req.topK : DEFAULT_TOP_K;
        String filterExpr = '';
        String diag;

        if (useBoost) {
            List<String> matchedIds = extractProductIds(req.query);
            if (!matchedIds.isEmpty()) {
                filterExpr = buildProductIdFilter(matchedIds);
                diag = 'Boost applied: filter on product IDs ' + matchedIds;
            } else {
                diag = 'Boosted path: no product ID match in query, falling back to unfiltered hybrid search.';
            }
        } else {
            diag = 'Naive path: no boost applied.';
        }

        String sql = buildSearchSql(req.query, filterExpr, topK);

        try {
            ConnectApi.CdpQueryInput input = new ConnectApi.CdpQueryInput();
            input.sql = sql;
            ConnectApi.CdpQueryOutputV2 out = ConnectApi.CdpQuery.queryAnsiSqlV2(input);
            resp.results = mapResults(out);
            resp.diagnosticInfo = diag + ' | rowCount=' + (out == null ? 0 : out.rowCount);
        } catch (Exception e) {
            resp.diagnosticInfo = diag + ' | ERROR: ' + e.getTypeName() + ': ' + e.getMessage();
        }
        return resp;
    }

    // ------------------------------------------------------------------
    // SQL-Konstruktion (testbar ohne Callout)
    // ------------------------------------------------------------------

    @TestVisible
    private static List<String> extractProductIds(String query) {
        List<String> ids = new List<String>();
        if (String.isBlank(query)) {
            return ids;
        }
        Matcher m = PRODUCT_ID_PATTERN.matcher(query);
        Set<String> seen = new Set<String>();
        while (m.find()) {
            String id = m.group();
            if (!seen.contains(id)) {
                seen.add(id);
                ids.add(id);
            }
        }
        return ids;
    }

    /**
     * Erzeugt den Filter-Ausdruck, der als String-Literal in die hybrid_search()-
     * SQL-Funktion eingebettet wird.  Da der Filter-Expression-String selbst in
     * Single Quotes steht, müssen Single Quotes innerhalb der Expression
     * verdoppelt werden.  Beispiel-Output für ID 'AL-3000-S':
     *
     *     productIds__c = ''AL-3000-S'' OR productIds__c LIKE ''AL-3000-S;%''
     *
     * Hinweis: Hybrid-Search-Filter lassen führende Wildcards (`%X`) NICHT zu –
     * das wäre die saubere Lösung für Multi-Value-Strings.  Stattdessen wird
     * pro ID eine Equality (Single-ID-Record) und ein Prefix-LIKE
     * (Multi-ID-Record mit dieser ID an erster Position) erzeugt.  Das
     * matched alle Single-ID-Treffer und Multi-ID-Treffer, wo die gesuchte
     * ID alphabetisch zuerst kommt.  Das Embedding-Ranking deckt den Rest ab.
     */
    @TestVisible
    private static String buildProductIdFilter(List<String> ids) {
        List<String> clauses = new List<String>();
        for (String id : ids) {
            String safeId = String.escapeSingleQuotes(id);
            clauses.add('productIds__c = \'\'' + safeId + '\'\'');
            clauses.add('productIds__c LIKE \'\'' + safeId + ';%\'\'');
        }
        return String.join(clauses, ' OR ');
    }

    /**
     * Baut den vollständigen ANSI-SQL-Ausdruck für queryAnsiSqlV2.
     *
     * Die hybrid_search()-Funktion gibt eine Tabelle mit RecordId__c (interne
     * UUID), den Score-Spalten (hybrid_score__c, vector_score__c, keyword_score__c)
     * und allen ausgewählten Metadaten-Feldern direkt zurück.  Den Original-
     * Text liefert der Chunk-DMO über `Chunk__c`, JOIN per RecordId__c (UUID).
     * SourceRecordId__c im Chunk-DMO trägt unsere fachliche recordId.
     *
     * Filter-Expression wird als String-Literal an Position 3 übergeben
     * (leerer String, wenn kein Boost).
     */
    @TestVisible
    private static String buildSearchSql(String query, String filterExpr, Integer topK) {
        String escapedQuery = String.escapeSingleQuotes(query);
        String safeFilter = filterExpr == null ? '' : filterExpr;
        return 'SELECT "v"."hybrid_score__c" AS "score", ' +
            '"c"."Chunk__c" AS "content", ' +
            '"v"."sourceFile__c" AS "sourceFile", ' +
            '"v"."sourceSection__c" AS "sourceSection", ' +
            '"v"."productIds__c" AS "productIds", ' +
            '"v"."docType__c" AS "docType" ' +
            'FROM hybrid_search(TABLE("' +
            INDEX_DLM_NAME +
            '"), \'' +
            escapedQuery +
            '\', \'' +
            safeFilter +
            '\', ' +
            topK +
            ') AS "v" ' +
            'INNER JOIN "' +
            CHUNK_DLM_NAME +
            '" AS "c" ON "c"."RecordId__c" = "v"."RecordId__c" ' +
            'ORDER BY "score" DESC';
    }

    // ------------------------------------------------------------------
    // Result-Mapping
    // ------------------------------------------------------------------

    @TestVisible
    private static List<SearchResult> mapResults(ConnectApi.CdpQueryOutputV2 out) {
        List<SearchResult> results = new List<SearchResult>();
        if (out == null || out.data == null) {
            return results;
        }
        // Position-based mapping nach Reihenfolge im SELECT in buildSearchSql:
        // 0: score, 1: content, 2: sourceFile, 3: sourceSection, 4: productIds, 5: docType
        for (ConnectApi.CdpQueryV2Row row : out.data) {
            if (row == null || row.rowData == null) {
                continue;
            }
            SearchResult r = new SearchResult();
            List<Object> rd = row.rowData;
            r.score = parseDecimal(rd.size() > 0 ? rd[0] : null);
            r.content = rd.size() > 1 ? toStringOrNull(rd[1]) : null;
            r.sourceFile = rd.size() > 2 ? toStringOrNull(rd[2]) : null;
            r.sourceSection = rd.size() > 3 ? toStringOrNull(rd[3]) : null;
            r.productIds = rd.size() > 4 ? toStringOrNull(rd[4]) : null;
            r.docType = rd.size() > 5 ? toStringOrNull(rd[5]) : null;
            results.add(r);
        }
        return results;
    }

    private static String toStringOrNull(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static Decimal parseDecimal(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Decimal) {
            return (Decimal) v;
        }
        if (v instanceof Double) {
            return Decimal.valueOf((Double) v);
        }
        if (v instanceof Integer) {
            return Decimal.valueOf((Integer) v);
        }
        if (v instanceof Long) {
            return Decimal.valueOf((Long) v);
        }
        try {
            return Decimal.valueOf(String.valueOf(v));
        } catch (Exception ex) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Inner Types
    // ------------------------------------------------------------------

    global class Request {
        @InvocableVariable(required=true description='User query in natural language')
        global String query;

        @InvocableVariable(required=false description='Number of chunks to retrieve, default 5')
        global Integer topK;
    }

    global class Response {
        @InvocableVariable
        global List<SearchResult> results;

        @InvocableVariable
        global String diagnosticInfo;
    }

    global class SearchResult {
        @InvocableVariable
        global String content;

        @InvocableVariable
        global String sourceFile;

        @InvocableVariable
        global String sourceSection;

        @InvocableVariable
        global String productIds;

        @InvocableVariable
        global String docType;

        @InvocableVariable
        global Decimal score;
    }
}
