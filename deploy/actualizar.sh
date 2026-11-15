#!/usr/bin/env bash
# Actualiza la tienda en el servidor con lo último que está en GitHub.
# Uso:  sudo /opt/tienda-online/deploy/actualizar.sh
set -euo pipefail

APP=/opt/tienda-online
cd "$APP"

echo "1/4 Copia de seguridad antes de actualizar..."
"$APP/deploy/backup.sh"

echo "2/4 Descargando la última versión de GitHub..."
sudo -u tienda git -C "$APP" pull --ff-only

echo "3/4 Instalando librerías..."
sudo -u tienda npm ci --omit=dev --no-fund --no-audit

echo "4/4 Reiniciando la tienda..."
systemctl restart tienda
sleep 2
systemctl --no-pager --lines=5 status tienda
echo "Listo. Versión actual: $(git -C "$APP" log -1 --format='%h %s')"
