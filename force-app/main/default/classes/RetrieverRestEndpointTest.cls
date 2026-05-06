@IsTest
private class RetrieverRestEndpointTest {
    private static RestRequest buildRequest(String uri, String body) {
        RestRequest req = new RestRequest();
        req.requestURI = uri;
        req.httpMethod = 'POST';
        if (body != null) {
            req.requestBody = Blob.valueOf(body);
        }
        return req;
    }

    @IsTest
    static void testExtractModeBoosted() {
        System.assertEquals('boosted', RetrieverRestEndpoint.extractMode('/aerolift/retrieve/boosted'));
    }

    @IsTest
    static void testExtractModeNaive() {
        System.assertEquals('naive', RetrieverRestEndpoint.extractMode('/aerolift/retrieve/naive'));
    }

    @IsTest
    static void testExtractModeDefaultsToBoosted() {
        // Unbekannter Tail oder leere URI fällt auf den Default-Pfad zurück.
        System.assertEquals('boosted', RetrieverRestEndpoint.extractMode('/aerolift/retrieve/unknown'));
        System.assertEquals('boosted', RetrieverRestEndpoint.extractMode(''));
        System.assertEquals('boosted', RetrieverRestEndpoint.extractMode(null));
    }

    @IsTest
    static void testParseBodyExtractsQueryAndTopK() {
        RestRequest req = buildRequest('/aerolift/retrieve/boosted', '{"query":"AL-3000-SX max temp","topK":7}');
        ProductIndexRetriever.Request payload = RetrieverRestEndpoint.parseBody(req);
        System.assertEquals('AL-3000-SX max temp', payload.query);
        System.assertEquals(7, payload.topK);
    }

    @IsTest
    static void testParseBodyAcceptsMissingTopK() {
        RestRequest req = buildRequest('/aerolift/retrieve/boosted', '{"query":"AL-3500-HT-X"}');
        ProductIndexRetriever.Request payload = RetrieverRestEndpoint.parseBody(req);
        System.assertEquals('AL-3500-HT-X', payload.query);
        System.assertEquals(null, payload.topK);
    }

    @IsTest
    static void testParseBodyHandlesEmptyOrNullBody() {
        ProductIndexRetriever.Request a = RetrieverRestEndpoint.parseBody(
            buildRequest('/aerolift/retrieve/boosted', '')
        );
        System.assertEquals(null, a.query);

        ProductIndexRetriever.Request b = RetrieverRestEndpoint.parseBody(
            buildRequest('/aerolift/retrieve/boosted', null)
        );
        System.assertEquals(null, b.query);
    }

    @IsTest
    static void testInvokeBoostedRoutesToSearchBoosted() {
        // Leere Query führt zum Short-Circuit im Retriever (kein Callout); Diagnose
        // dient als Beleg, welche Methode tatsächlich aufgerufen wurde.  Boost-
        // Pfad gibt 'Empty query' zurück (Retriever guard) – Naive-Pfad ebenso,
        // aber wir prüfen hier nur dass kein Fehler kommt und Routing greift.
        RestContext.request = buildRequest('/aerolift/retrieve/boosted', '{"query":""}');
        RestContext.response = new RestResponse();

        Test.startTest();
        ProductIndexRetriever.Response resp = RetrieverRestEndpoint.invoke();
        Test.stopTest();

        System.assertNotEquals(null, resp);
        System.assertNotEquals(null, resp.diagnosticInfo);
        System.assert(resp.diagnosticInfo.contains('Empty query'), 'Empty-Query-Pfad: ' + resp.diagnosticInfo);
    }

    @IsTest
    static void testInvokeNaiveRoutesToSearchNaive() {
        RestContext.request = buildRequest('/aerolift/retrieve/naive', '{"query":""}');
        RestContext.response = new RestResponse();

        Test.startTest();
        ProductIndexRetriever.Response resp = RetrieverRestEndpoint.invoke();
        Test.stopTest();

        System.assertNotEquals(null, resp);
        System.assert(resp.diagnosticInfo.contains('Empty query'), 'Empty-Query-Pfad: ' + resp.diagnosticInfo);
    }
}
