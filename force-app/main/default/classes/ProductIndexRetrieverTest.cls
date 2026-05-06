/**
 * Tests für ProductIndexRetriever.
 *
 * Strategie: Logik-Tests (Option C). Es gibt aktuell kein dokumentiertes
 * setTestQueryAnsiSqlV2-Stub-Pattern in ConnectApi.CdpQuery, und
 * Dependency-Injection-Refactor wäre Overhead für ein zwei-Methoden-API.
 * Deshalb testen wir die Logik-Kernpunkte direkt:
 *   - extractProductIds: Erkennung aller AeroLift-Modell-IDs in einer Query
 *   - buildProductIdFilter: SQL-Filter-Expression mit korrektem Quote-Escape
 *   - buildSearchSql: kompletter SELECT mit hybrid_search()-Aufruf
 *
 * `ConnectApi.CdpQuery.queryAnsiSqlV2` selbst ist Plattform-Code und braucht
 * keinen Test-Mock unsererseits.
 */
@IsTest
private class ProductIndexRetrieverTest {
    @IsTest
    static void testExtractProductIdsFindsAllVariants() {
        List<String> ids = ProductIndexRetriever.extractProductIds(
            'Vergleich AL-3000, AL-3000-S, AL-3000-SX, AL-3500, AL-3500-HT, AL-3500-HT-X'
        );
        System.assertEquals(6, ids.size(), 'Alle sechs Modell-IDs erkannt');
        System.assert(ids.contains('AL-3000'), 'Basis');
        System.assert(ids.contains('AL-3000-S'), 'S-Variante');
        System.assert(ids.contains('AL-3000-SX'), 'SX-Variante');
        System.assert(ids.contains('AL-3500'), 'AL-3500-Basis');
        System.assert(ids.contains('AL-3500-HT'), 'HT-Variante');
        System.assert(ids.contains('AL-3500-HT-X'), 'HT-X-Variante');
    }

    @IsTest
    static void testExtractProductIdsIgnoresFalsePositives() {
        // Diese Strings dürfen den Pattern-Match NICHT auslösen:
        //   'AL-99'       – nur zwei Ziffern, Pattern verlangt vier
        //   'AL3000'      – Bindestrich fehlt
        //   'XL-3000-S'   – falsches Präfix
        // Hinweis: 'AL-30000' enthält 'AL-3000' als Substring, daher als
        // False-Positive nicht eindeutig negativ – wir lassen ihn deshalb weg.
        List<String> ids = ProductIndexRetriever.extractProductIds(
            'Bei AL-99 oder AL3000 oder XL-3000-S ist nichts zu erkennen.'
        );
        System.assertEquals(0, ids.size(), 'Keine valide Modell-ID, keine Treffer: ' + ids);
    }

    @IsTest
    static void testExtractProductIdsDeduplicates() {
        List<String> ids = ProductIndexRetriever.extractProductIds('AL-3000-S vs AL-3000-S vs AL-3000-S');
        System.assertEquals(1, ids.size(), 'Doppelte IDs werden dedupliziert');
        System.assertEquals('AL-3000-S', ids[0]);
    }

    @IsTest
    static void testBuildProductIdFilterSingleId() {
        String filter = ProductIndexRetriever.buildProductIdFilter(new List<String>{ 'AL-3000-S' });
        // Pro ID werden zwei Klauseln erzeugt (Equality für Single-ID-Records,
        // Prefix-LIKE für Multi-ID-Records mit dieser ID an erster Position).
        System.assertEquals('productIds__c = \'\'AL-3000-S\'\' OR productIds__c LIKE \'\'AL-3000-S;%\'\'', filter);
    }

    @IsTest
    static void testBuildProductIdFilterMultipleIds() {
        String filter = ProductIndexRetriever.buildProductIdFilter(new List<String>{ 'AL-3000-SX', 'AL-3500-HT-X' });
        System.assert(filter.contains('AL-3000-SX'), 'erste ID enthalten');
        System.assert(filter.contains('AL-3500-HT-X'), 'zweite ID enthalten');
        System.assert(filter.contains(' OR '), 'Klauseln per OR verknüpft');
        // Zwei Klauseln pro ID -> bei zwei IDs vier Klauseln, also drei OR-Trennzeichen.
        System.assertEquals(4, filter.split(' OR ').size(), 'vier Klauseln (2 pro ID)');
    }

    @IsTest
    static void testBuildSearchSqlBoostedPath() {
        String filter = ProductIndexRetriever.buildProductIdFilter(new List<String>{ 'AL-3000-SX' });
        String sql = ProductIndexRetriever.buildSearchSql(
            'Welche maximale Medientemperatur hat die AL-3000-SX?',
            filter,
            5
        );
        System.assert(sql.contains('hybrid_search('), 'hybrid_search() im SQL');
        System.assert(sql.contains('TABLE("AeroLift_Document_Chunk_index__dlm")'), 'Index-DLM korrekt referenziert');
        System.assert(sql.contains('"AeroLift_Document_Chunk_chunk__dlm"'), 'Chunk-DMO im JOIN für Original-Text');
        System.assert(sql.contains('AL-3000-SX'), 'Filter-ID landet im SQL');
        System.assert(sql.contains('productIds__c = \'\'AL-3000-SX\'\''), 'Equality-Klausel im Filter');
        System.assert(sql.contains('productIds__c LIKE \'\'AL-3000-SX;%\'\''), 'Prefix-LIKE im Filter');
        System.assert(sql.contains('ORDER BY "score" DESC'), 'Score-Sortierung');
        System.assert(sql.endsWith('ORDER BY "score" DESC'), 'SQL endet sauber');
    }

    @IsTest
    static void testBuildSearchSqlNaivePath() {
        String sql = ProductIndexRetriever.buildSearchSql('Welche Pumpe verträgt 220 °C?', '', 5);
        System.assert(sql.contains('hybrid_search('), 'hybrid_search() auch im Naive-Pfad');
        // Naive-Pfad: dritter Argument-Slot ist ein leerer String, daher zwei
        // konsekutive Single Quotes für die Filter-Position.
        System.assert(sql.contains(', \'\','), 'leere Filter-Position im SQL');
        System.assert(!sql.contains('productIds__c LIKE'), 'Kein Filter ohne Boost');
    }

    @IsTest
    static void testBuildSearchSqlEscapesSingleQuotesInQuery() {
        String sql = ProductIndexRetriever.buildSearchSql('Was kann \'AL-3000-S\'?', '', 5);
        // String.escapeSingleQuotes verdoppelt Single Quotes; im resultierenden
        // SQL stehen damit zwei aufeinanderfolgende Quotes statt eines unsicheren.
        System.assert(sql.contains('\\\''), 'Backslash-Escape in der Query');
    }
}
