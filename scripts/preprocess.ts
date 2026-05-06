// preprocess.ts – Pre-Processing der Markdown-Quellen zu strukturierten Records
// für Variante B (Data Cloud Custom Vector Search).
//
// Runtime: Node.js >= v23 mit nativem TypeScript-Support (oder >= v22 mit
// `--experimental-strip-types`). Aufruf: `node scripts/preprocess.ts`.
//
// Output:
//   data-cloud/records/<basename>.records.json   – ein Array Records pro Quelldatei
//   data-cloud/records/all-records.json          – gemergt
//   data-cloud/csv/<basename>.csv                – CSV-Spaltenmapping 1:1 zum DLO
//
// Markdown-Tabellen werden über den marked-Lexer (mdast-ähnlich) zerlegt; pro
// Tabellenzeile entsteht ein Record. Prose-Sektionen werden pro H2/H3-Sektion
// als ein Record gesammelt.

import { marked, type Tokens } from 'marked';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Pfade
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE_DIR = join(REPO_ROOT, 'content', 'source');
const RECORDS_DIR = join(REPO_ROOT, 'data-cloud', 'records');
const CSV_DIR = join(REPO_ROOT, 'data-cloud', 'csv');

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

type DocType =
    | 'catalog'
    | 'spec-sheet'
    | 'maintenance'
    | 'compatibility'
    | 'atex'
    | 'changelog'
    | 'faq';

interface DocumentChunk {
    recordId: string;
    sourceFile: string;
    sourceSection: string;
    chunkType: 'table-row' | 'prose';
    content: string;
    productIds: string[];
    docType: DocType;
    atexZone: '0' | '1' | '2' | null;
    tempMaxC: number | null;
    foerderleistungM3h: number | null;
    werkstoffGehaeuse: string | null;
    ex_certified: boolean | null;
    wirkungsgradPct: number | null;
    druckMaxBar: number | null;
    antriebsleistungKW: number | null;
}

// ---------------------------------------------------------------------------
// docType-Mapping
// ---------------------------------------------------------------------------

function docTypeFromFilename(file: string): DocType {
    if (file === 'product-catalog.md') return 'catalog';
    if (file.startsWith('spec-sheet-')) return 'spec-sheet';
    if (file === 'maintenance-manual.md') return 'maintenance';
    if (file === 'compatibility-matrix.md') return 'compatibility';
    if (file === 'atex-guide.md') return 'atex';
    if (file === 'changelog.md') return 'changelog';
    if (file === 'faq.md') return 'faq';
    throw new Error(`Unbekannte Quelldatei (kein docType-Mapping): ${file}`);
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const PRODUCT_ID_REGEX = /AL-\d{4}(?:-[A-Z]+)*\b/g;

function extractProductIds(text: string): string[] {
    const matches = text.match(PRODUCT_ID_REGEX) ?? [];
    return Array.from(new Set(matches));
}

function parseNumberWithUnit(value: string): number | null {
    // "80 m³/h" → 80, "150 °C" → 150, "16 bar" → 16, "72 %" → 72
    // Komma als Dezimaltrenner ebenfalls akzeptieren.
    const m = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
}

function parseAtex(value: string): { zone: '0' | '1' | '2' | null; certified: boolean } {
    const v = value.trim().toLowerCase();
    if (!v || v === 'keine' || v === 'nein' || v === '–' || v === '-') {
        return { zone: null, certified: false };
    }
    // "ATEX Zone 1 (Gas)", "Zone 2 (Gas)"
    const m = v.match(/zone\s*(\d)/);
    if (m) {
        const zone = m[1];
        if (zone === '0' || zone === '1' || zone === '2') {
            return { zone, certified: true };
        }
    }
    return { zone: null, certified: false };
}

interface ColumnMapping {
    type:
        | 'id'
        | 'foerderleistung'
        | 'tempMax'
        | 'druckMax'
        | 'werkstoff'
        | 'wirkungsgrad'
        | 'antriebsleistung'
        | 'atex'
        | 'other';
    rawHeader: string;
}

function classifyHeader(header: string): ColumnMapping {
    const h = header.toLowerCase();
    if (h === 'modell' || h === 'pumpe') return { type: 'id', rawHeader: header };
    if (h.includes('förderleistung')) return { type: 'foerderleistung', rawHeader: header };
    if (h.includes('temp')) return { type: 'tempMax', rawHeader: header };
    if (h.includes('druck') && !h.includes('saug')) return { type: 'druckMax', rawHeader: header };
    if (h.includes('werkstoff')) return { type: 'werkstoff', rawHeader: header };
    if (h.includes('wirkungsgrad')) return { type: 'wirkungsgrad', rawHeader: header };
    if (h.includes('antriebsleistung')) return { type: 'antriebsleistung', rawHeader: header };
    if (h.includes('ex-schutz') || h.includes('ex schutz') || h === 'ex-zone' || h === 'ex zone') {
        return { type: 'atex', rawHeader: header };
    }
    return { type: 'other', rawHeader: header };
}

// ---------------------------------------------------------------------------
// Markdown-Verarbeitung
// ---------------------------------------------------------------------------

interface ProseBuffer {
    section: string;
    sectionSlug: string;
    parts: string[];
}

function flushProse(
    buffer: ProseBuffer | null,
    sourceFile: string,
    docType: DocType,
    counter: { value: number },
    out: DocumentChunk[],
): void {
    if (!buffer) return;
    const content = buffer.parts.join('\n\n').trim();
    if (!content) return;
    const idx = counter.value++;
    out.push({
        recordId: `${sourceFile}::${buffer.sectionSlug}::chunk-${idx}`,
        sourceFile,
        sourceSection: buffer.section,
        chunkType: 'prose',
        content,
        productIds: extractProductIds(content),
        docType,
        atexZone: null,
        tempMaxC: null,
        foerderleistungM3h: null,
        werkstoffGehaeuse: null,
        ex_certified: null,
        wirkungsgradPct: null,
        druckMaxBar: null,
        antriebsleistungKW: null,
    });
}

function processTable(
    table: Tokens.Table,
    section: string,
    sectionSlug: string,
    sourceFile: string,
    docType: DocType,
    out: DocumentChunk[],
): void {
    const headers = table.header.map((c) => c.text);
    const mappings = headers.map(classifyHeader);
    const idIdx = mappings.findIndex((m) => m.type === 'id');

    table.rows.forEach((row, rowIdx) => {
        const cells = row.map((c) => c.text);
        const renderedParts = headers.map((h, i) => `${h}: ${cells[i] ?? ''}`);
        const content = renderedParts.join(' | ');

        // Strukturierte Felder ableiten
        let productIds: string[] = [];
        if (idIdx >= 0) {
            const idCell = cells[idIdx] ?? '';
            const ids = extractProductIds(idCell);
            productIds = ids.length > 0 ? ids : (idCell.trim() ? [idCell.trim()] : []);
        } else {
            productIds = extractProductIds(content);
        }

        let tempMaxC: number | null = null;
        let foerderleistungM3h: number | null = null;
        let druckMaxBar: number | null = null;
        let werkstoffGehaeuse: string | null = null;
        let wirkungsgradPct: number | null = null;
        let antriebsleistungKW: number | null = null;
        let atexZone: '0' | '1' | '2' | null = null;
        let exCertified: boolean | null = null;

        mappings.forEach((m, i) => {
            const v = cells[i] ?? '';
            switch (m.type) {
                case 'tempMax':
                    tempMaxC = parseNumberWithUnit(v);
                    break;
                case 'foerderleistung':
                    foerderleistungM3h = parseNumberWithUnit(v);
                    break;
                case 'druckMax':
                    druckMaxBar = parseNumberWithUnit(v);
                    break;
                case 'werkstoff':
                    werkstoffGehaeuse = v.trim() || null;
                    break;
                case 'wirkungsgrad':
                    wirkungsgradPct = parseNumberWithUnit(v);
                    break;
                case 'antriebsleistung':
                    antriebsleistungKW = parseNumberWithUnit(v);
                    break;
                case 'atex': {
                    const parsed = parseAtex(v);
                    atexZone = parsed.zone;
                    exCertified = parsed.certified;
                    break;
                }
                default:
                    break;
            }
        });

        out.push({
            recordId: `${sourceFile}::${sectionSlug}::row-${rowIdx + 1}`,
            sourceFile,
            sourceSection: section,
            chunkType: 'table-row',
            content,
            productIds,
            docType,
            atexZone,
            tempMaxC,
            foerderleistungM3h,
            werkstoffGehaeuse,
            ex_certified: exCertified,
            wirkungsgradPct,
            druckMaxBar,
            antriebsleistungKW,
        });
    });
}

function processFile(sourceFile: string, raw: string): DocumentChunk[] {
    const docType = docTypeFromFilename(sourceFile);
    const tokens = marked.lexer(raw);
    const records: DocumentChunk[] = [];
    let currentSection = '(Dokumentenanfang)';
    let currentSlug = 'preamble';
    let proseBuffer: ProseBuffer | null = null;
    const proseCounter = { value: 0 };

    for (const token of tokens) {
        if (token.type === 'heading') {
            const h = token as Tokens.Heading;
            if (h.depth === 1) {
                // H1 markiert den Dokumentenanfang – Buffer flushen, Section setzen.
                flushProse(proseBuffer, sourceFile, docType, proseCounter, records);
                proseBuffer = null;
                currentSection = h.text;
                currentSlug = 'preamble';
                continue;
            }
            if (h.depth === 2 || h.depth === 3) {
                flushProse(proseBuffer, sourceFile, docType, proseCounter, records);
                currentSection = h.text;
                currentSlug = slugify(h.text);
                proseBuffer = { section: currentSection, sectionSlug: currentSlug, parts: [] };
                continue;
            }
            // H4+ als Prose-Inhalt behandeln
            if (proseBuffer) proseBuffer.parts.push((token as Tokens.Heading).raw);
            continue;
        }

        if (token.type === 'table') {
            // Tabelle als atomare Zeilen-Records ausgeben (separat von Prose).
            flushProse(proseBuffer, sourceFile, docType, proseCounter, records);
            processTable(
                token as Tokens.Table,
                currentSection,
                currentSlug,
                sourceFile,
                docType,
                records,
            );
            // Prose-Buffer für die aktuelle Section neu öffnen, damit nachfolgende
            // Absätze unter derselben Section landen.
            proseBuffer = { section: currentSection, sectionSlug: currentSlug, parts: [] };
            continue;
        }

        // Alles andere ist Prose (paragraph, list, blockquote, code, ...).
        if (proseBuffer && 'raw' in token && typeof (token as { raw: unknown }).raw === 'string') {
            const raw = (token as { raw: string }).raw.trim();
            if (raw) proseBuffer.parts.push(raw);
        }
    }

    flushProse(proseBuffer, sourceFile, docType, proseCounter, records);
    return records;
}

// ---------------------------------------------------------------------------
// CSV-Erzeugung
// ---------------------------------------------------------------------------

const CSV_COLUMNS: (keyof DocumentChunk)[] = [
    'recordId',
    'sourceFile',
    'sourceSection',
    'chunkType',
    'content',
    'productIds',
    'docType',
    'atexZone',
    'tempMaxC',
    'foerderleistungM3h',
    'werkstoffGehaeuse',
    'ex_certified',
    'wirkungsgradPct',
    'druckMaxBar',
    'antriebsleistungKW',
];

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    let s: string;
    if (Array.isArray(value)) {
        s = value.join(';');
    } else if (typeof value === 'boolean') {
        s = value ? 'true' : 'false';
    } else {
        s = String(value);
    }
    if (/[",\n\r]/.test(s)) {
        s = `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function recordsToCsv(records: DocumentChunk[]): string {
    const BOM = '\uFEFF';
    const header = CSV_COLUMNS.join(',');
    const lines = records.map((r) =>
        CSV_COLUMNS.map((col) => csvEscape(r[col])).join(','),
    );
    return BOM + [header, ...lines].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Konsistenz-Check
// ---------------------------------------------------------------------------

function findRecordWithProductId(
    records: DocumentChunk[],
    sourceFile: string,
    productId: string,
    chunkType?: 'table-row' | 'prose',
): DocumentChunk | undefined {
    return records.find(
        (r) =>
            r.sourceFile === sourceFile &&
            r.productIds.includes(productId) &&
            (chunkType ? r.chunkType === chunkType : true),
    );
}

function consistencyCheck(records: DocumentChunk[]): void {
    const errors: string[] = [];

    // Mind. 1 Record pro Modell-ID in product-catalog.md
    const ids = ['AL-3000', 'AL-3000-S', 'AL-3000-SX', 'AL-3500', 'AL-3500-HT', 'AL-3500-HT-X'];
    for (const id of ids) {
        const hits = records.filter(
            (r) => r.sourceFile === 'product-catalog.md' && r.productIds.includes(id),
        );
        if (hits.length === 0) {
            errors.push(`product-catalog.md enthält keinen Record für Modell-ID '${id}'`);
        }
    }

    // Q01: AL-3000-SX → tempMaxC === 150 in der Spec-Übersicht (catalog table-row)
    const sx = records.find(
        (r) =>
            r.sourceFile === 'product-catalog.md' &&
            r.chunkType === 'table-row' &&
            r.productIds.length === 1 &&
            r.productIds[0] === 'AL-3000-SX' &&
            r.sourceSection.toLowerCase().includes('spezifikation'),
    );
    if (!sx || sx.tempMaxC !== 150) {
        errors.push(
            `Q01-Check fehlgeschlagen: AL-3000-SX tempMaxC erwartet 150, erhalten ${sx?.tempMaxC ?? 'kein Record'}`,
        );
    }

    // Q03: AL-3500-HT-X kommt im maintenance-manual vor
    const htxMaint = findRecordWithProductId(records, 'maintenance-manual.md', 'AL-3500-HT-X');
    if (!htxMaint) {
        errors.push(`Q03-Check fehlgeschlagen: kein Record mit AL-3500-HT-X in maintenance-manual.md`);
    }

    // Q08: AL-3000 in catalog → ex_certified false (oder atexZone null)
    const catBase = records.find(
        (r) =>
            r.sourceFile === 'product-catalog.md' &&
            r.chunkType === 'table-row' &&
            r.productIds.length === 1 &&
            r.productIds[0] === 'AL-3000' &&
            r.sourceSection.toLowerCase().includes('spezifikation'),
    );
    if (!catBase) {
        errors.push(`Q08-Check fehlgeschlagen: kein Spec-Row für AL-3000 (Basismodell)`);
    } else if (catBase.ex_certified !== false || catBase.atexZone !== null) {
        errors.push(
            `Q08-Check fehlgeschlagen: AL-3000 ex_certified=${catBase.ex_certified}, atexZone=${catBase.atexZone}`,
        );
    }

    // Q14: AL-3000-S in catalog → atexZone === "2"
    const s = records.find(
        (r) =>
            r.sourceFile === 'product-catalog.md' &&
            r.chunkType === 'table-row' &&
            r.productIds.length === 1 &&
            r.productIds[0] === 'AL-3000-S' &&
            r.sourceSection.toLowerCase().includes('spezifikation'),
    );
    if (!s || s.atexZone !== '2') {
        errors.push(
            `Q14-Check fehlgeschlagen: AL-3000-S atexZone erwartet "2", erhalten ${s?.atexZone ?? 'kein Record'}`,
        );
    }

    // Q15: AL-3000-SX werkstoffGehaeuse enthält "1.4408"
    if (!sx || !sx.werkstoffGehaeuse?.includes('1.4408')) {
        errors.push(
            `Q15-Check fehlgeschlagen: AL-3000-SX werkstoffGehaeuse erwartet enthält "1.4408", erhalten ${sx?.werkstoffGehaeuse}`,
        );
    }

    if (errors.length > 0) {
        console.error('\nKonsistenz-Check fehlgeschlagen:');
        for (const e of errors) console.error('  - ' + e);
        process.exit(1);
    }
    console.log('Konsistenz-Check: alle Spotchecks bestanden.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    if (!existsSync(SOURCE_DIR)) {
        console.error(`FEHLER: Quellverzeichnis nicht gefunden: ${SOURCE_DIR}`);
        process.exit(1);
    }
    await mkdir(RECORDS_DIR, { recursive: true });
    await mkdir(CSV_DIR, { recursive: true });

    const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.md')).sort();
    if (files.length === 0) {
        console.error(`FEHLER: Keine .md-Dateien in ${SOURCE_DIR}`);
        process.exit(1);
    }

    const all: DocumentChunk[] = [];
    const perFile = new Map<string, DocumentChunk[]>();

    for (const file of files) {
        const raw = await readFile(join(SOURCE_DIR, file), 'utf8');
        const records = processFile(file, raw);
        perFile.set(file, records);
        all.push(...records);

        await writeFile(
            join(RECORDS_DIR, file.replace(/\.md$/, '.records.json')),
            JSON.stringify(records, null, 2) + '\n',
            'utf8',
        );
        await writeFile(
            join(CSV_DIR, file.replace(/\.md$/, '.csv')),
            recordsToCsv(records),
            'utf8',
        );
    }

    await writeFile(
        join(RECORDS_DIR, 'all-records.json'),
        JSON.stringify(all, null, 2) + '\n',
        'utf8',
    );
    await writeFile(
        join(CSV_DIR, 'all-records.csv'),
        recordsToCsv(all),
        'utf8',
    );

    // Logging
    console.log(`\nVerarbeitete Dateien: ${files.length}`);
    console.log(`Records gesamt:       ${all.length}`);
    console.log('');
    console.log('Pro Datei:');
    for (const file of files) {
        const recs = perFile.get(file)!;
        const tableRows = recs.filter((r) => r.chunkType === 'table-row').length;
        const prose = recs.filter((r) => r.chunkType === 'prose').length;
        console.log(
            `  ${file.padEnd(35)}  total ${String(recs.length).padStart(3)}  ` +
                `(table-row ${String(tableRows).padStart(3)}, prose ${String(prose).padStart(2)})`,
        );
    }
    console.log('');
    const totalTable = all.filter((r) => r.chunkType === 'table-row').length;
    const totalProse = all.filter((r) => r.chunkType === 'prose').length;
    console.log(`Verteilung gesamt:    table-row ${totalTable}, prose ${totalProse}`);
    console.log('');

    consistencyCheck(all);
}

await main();
