/**
 * REST-Wrapper für ProductIndexRetriever, damit der Eval-Harness den Retriever
 * direkt (ohne Umweg über einen Agent) aufrufen kann.
 *
 * Pfade:
 *   POST /services/apexrest/aerolift/retrieve/boosted
 *   POST /services/apexrest/aerolift/retrieve/naive
 *
 * Body: { "query": "...", "topK": 5 }
 * Response: ProductIndexRetriever.Response (results + diagnosticInfo)
 */
@RestResource(urlMapping='/aerolift/retrieve/*')
global with sharing class RetrieverRestEndpoint {
    @TestVisible
    private static final String MODE_NAIVE = 'naive';
    @TestVisible
    private static final String MODE_BOOSTED = 'boosted';

    @HttpPost
    global static ProductIndexRetriever.Response invoke() {
        RestRequest req = RestContext.request;
        String mode = extractMode(req == null ? null : req.requestURI);

        ProductIndexRetriever.Request payload = parseBody(req);

        List<ProductIndexRetriever.Response> resps = (mode == MODE_NAIVE)
            ? ProductIndexRetriever.searchNaive(new List<ProductIndexRetriever.Request>{ payload })
            : ProductIndexRetriever.searchBoosted(new List<ProductIndexRetriever.Request>{ payload });

        return resps.isEmpty() ? new ProductIndexRetriever.Response() : resps[0];
    }

    @TestVisible
    private static String extractMode(String requestUri) {
        if (String.isBlank(requestUri)) {
            return MODE_BOOSTED;
        }
        String tail = requestUri.substringAfterLast('/');
        return tail == MODE_NAIVE ? MODE_NAIVE : MODE_BOOSTED;
    }

    @TestVisible
    private static ProductIndexRetriever.Request parseBody(RestRequest req) {
        ProductIndexRetriever.Request r = new ProductIndexRetriever.Request();
        if (req == null || req.requestBody == null) {
            return r;
        }
        String raw = req.requestBody.toString();
        if (String.isBlank(raw)) {
            return r;
        }
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(raw);
        if (body.containsKey('query')) {
            r.query = (String) body.get('query');
        }
        if (body.containsKey('topK') && body.get('topK') != null) {
            r.topK = Integer.valueOf(body.get('topK'));
        }
        return r;
    }
}
