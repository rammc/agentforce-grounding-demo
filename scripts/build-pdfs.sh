#!/usr/bin/env bash
# build-pdfs.sh – konvertiert alle Markdown-Quellen in content/source/
# nach PDF mit Pandoc + Eisvogel + xelatex.
#
# Idempotent: bei mehrfachem Lauf werden bestehende PDFs überschrieben.
# Quell-Markdown wird nicht verändert; alle Pandoc-Variablen werden
# über CLI-Argumente gesetzt.

set -euo pipefail

# --- Pfad-Setup ---------------------------------------------------------

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
SOURCE_DIR="${REPO_ROOT}/content/source"
OUTPUT_DIR="${REPO_ROOT}/content/pdf"
TEMPLATE_DIR="${SCRIPT_DIR}/templates"
EISVOGEL_VERSION="3.4.0"
EISVOGEL_TEMPLATE="${TEMPLATE_DIR}/eisvogel.latex"

mkdir -p "${OUTPUT_DIR}" "${TEMPLATE_DIR}"

# --- Vorab-Checks -------------------------------------------------------

check_tool() {
    local tool="$1"
    local install_hint="$2"
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "FEHLER: '${tool}' wurde nicht gefunden." >&2
        echo "Installations-Hinweis (macOS):" >&2
        echo "  ${install_hint}" >&2
        exit 1
    fi
}

check_tool pandoc  "brew install pandoc"
check_tool xelatex "brew install --cask basictex   # nach Installation: 'eval \"\$(/usr/libexec/path_helper)\"' und ggf. 'sudo tlmgr update --self && sudo tlmgr install adjustbox babel-german background bidi collectbox csquotes everypage filehook footmisc footnotebackref framed fvextra letltxmacro ly1 mdframed mweights needspace pagecolor sourcecodepro sourcesanspro titling ucharcat ulem unicode-math upquote xecjk xurl zref'"

# --- Eisvogel-Template (Versionspin) ------------------------------------

if [[ ! -f "${EISVOGEL_TEMPLATE}" ]]; then
    echo "Lade Eisvogel-Template Version ${EISVOGEL_VERSION} ..."
    TARBALL_URL="https://github.com/Wandmalfarbe/pandoc-latex-template/releases/download/v${EISVOGEL_VERSION}/Eisvogel-${EISVOGEL_VERSION}.tar.gz"
    TMP_TARBALL="$(mktemp -t eisvogel.XXXXXX.tar.gz)"
    if ! curl -fsSL -o "${TMP_TARBALL}" "${TARBALL_URL}"; then
        echo "FEHLER: Download des Eisvogel-Templates fehlgeschlagen (${TARBALL_URL})." >&2
        rm -f "${TMP_TARBALL}"
        exit 1
    fi
    TMP_EXTRACT="$(mktemp -d -t eisvogel.XXXXXX)"
    tar -xzf "${TMP_TARBALL}" -C "${TMP_EXTRACT}"
    EISVOGEL_FOUND="$(find "${TMP_EXTRACT}" -name 'eisvogel.latex' -type f | head -1)"
    if [[ -z "${EISVOGEL_FOUND}" ]]; then
        echo "FEHLER: Konnte 'eisvogel.latex' im Archiv nicht finden." >&2
        rm -rf "${TMP_EXTRACT}" "${TMP_TARBALL}"
        exit 1
    fi
    cp "${EISVOGEL_FOUND}" "${EISVOGEL_TEMPLATE}"
    rm -rf "${TMP_EXTRACT}" "${TMP_TARBALL}"
    echo "Eisvogel-Template installiert: ${EISVOGEL_TEMPLATE}"
fi

# --- Titel-Mapping ------------------------------------------------------

title_for() {
    case "$1" in
        product-catalog.md)            echo "Produktkatalog" ;;
        spec-sheet-AL-3000-family.md)  echo "Datenblatt AL-3000-Reihe" ;;
        spec-sheet-AL-3500-family.md)  echo "Datenblatt AL-3500-Reihe" ;;
        maintenance-manual.md)         echo "Wartungshandbuch" ;;
        compatibility-matrix.md)       echo "Medienkompatibilität" ;;
        atex-guide.md)                 echo "ATEX-Leitfaden" ;;
        changelog.md)                  echo "Versionshistorie" ;;
        faq.md)                        echo "Häufig gestellte Fragen" ;;
        *)                             echo "" ;;
    esac
}

needs_toc() {
    case "$1" in
        product-catalog.md|maintenance-manual.md|compatibility-matrix.md|atex-guide.md)
            return 0 ;;
        *)
            return 1 ;;
    esac
}

# --- Konvertierung ------------------------------------------------------

shopt -s nullglob
SOURCES=( "${SOURCE_DIR}"/*.md )
if [[ ${#SOURCES[@]} -eq 0 ]]; then
    echo "FEHLER: Keine Markdown-Dateien in ${SOURCE_DIR} gefunden." >&2
    exit 1
fi

echo "Konvertiere ${#SOURCES[@]} Markdown-Dateien -> PDF ..."
echo ""

for src in "${SOURCES[@]}"; do
    fname="$(basename "${src}")"
    title="$(title_for "${fname}")"
    if [[ -z "${title}" ]]; then
        echo "WARNUNG: Kein Titel-Mapping für '${fname}', verwende Dateiname." >&2
        title="${fname%.md}"
    fi
    out="${OUTPUT_DIR}/${fname%.md}.pdf"

    pandoc_args=(
        "${src}"
        --output="${out}"
        --from=markdown
        --pdf-engine=xelatex
        --template="${EISVOGEL_TEMPLATE}"
        --metadata=title:"${title}"
        --metadata=subtitle:"AeroLift Industries"
        --metadata=author:"AeroLift Industries – Technische Dokumentation"
        --metadata=date:"Januar 2026"
        --metadata=lang:"de-DE"
        --variable=titlepage:true
        --variable=titlepage-rule-color:"3F5364"
        --variable=book:false
    )

    if needs_toc "${fname}"; then
        pandoc_args+=( --toc --toc-depth=2 --variable=toc-own-page:true )
    fi

    echo "  ${fname} -> ${fname%.md}.pdf"
    pandoc "${pandoc_args[@]}"
done

echo ""
echo "Fertig. Output: ${OUTPUT_DIR}"
