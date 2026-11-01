#!/bin/bash
# Install the latest ORDS into the image during `docker build`. Runs as root.
set -euo pipefail

ORDS_HOME="/opt/oracle/ords"
ORDS_CONFIG="/etc/ords/config"

echo "=== Installing ORDS (latest) ==="

# ORDS needs a JRE; Java 17 is the current LTS ORDS supports.
microdnf install -y java-17-openjdk-headless unzip curl && microdnf clean all

mkdir -p "$ORDS_HOME" "$ORDS_CONFIG"
cd /tmp
curl -fsSL -o ords.zip "https://download.oracle.com/otn_software/java/ords/ords-latest.zip"
unzip -q ords.zip -d "$ORDS_HOME"
rm ords.zip

ln -sf "$ORDS_HOME/bin/ords" /usr/local/bin/ords

export ORDS_CONFIG
ords config set --global config.dir "$ORDS_CONFIG"

echo "=== ORDS installed: $(ords --version 2>/dev/null || echo 'version unknown') ==="
