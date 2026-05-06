#!/usr/bin/env bash
# Einmalige Installation der von Eisvogel benötigten LaTeX-Pakete.
# Voraussetzung: BasicTeX ist installiert und tlmgr im PATH.
# Aufruf: sudo ./scripts/install-tex-packages.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Bitte mit sudo aufrufen: sudo $0" >&2
    exit 1
fi

eval "$(/usr/libexec/path_helper)"

PACKAGES=(
    adjustbox
    babel-german
    background
    bidi
    collectbox
    csquotes
    everypage
    footmisc
    footnotebackref
    framed
    fvextra
    mdframed
    mweights
    needspace
    pagecolor
    sourcecodepro
    sourcesanspro
    titling
    xecjk
    xurl
    zref
)

echo "Update tlmgr..."
tlmgr update --self

echo "Installiere ${#PACKAGES[@]} Pakete..."
tlmgr install "${PACKAGES[@]}"

echo "Fertig."
