#!/usr/bin/env bash
# Copia de seguridad diaria de la tienda: base de datos + fotos.
# Guarda los últimos 14 días en /var/backups/tienda.
#
# Probar a mano:   sudo /opt/tienda-online/deploy/backup.sh
# Programar todos los días a las 3:00 (ver la guía, paso 9).
set -euo pipefail

APP=/opt/tienda-online
DEST=/var/backups/tienda
KEEP_DAYS=14
STAMP=$(date +%Y-%m-%d_%H%M)

mkdir -p "$DEST"
chmod 700 "$DEST"

# Copia consistente de la base de datos aunque la tienda esté funcionando
node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
" "$APP/data/tienda.db" "$DEST/tienda-$STAMP.db"

# Fotos de los productos
tar -czf "$DEST/fotos-$STAMP.tar.gz" -C "$APP" uploads

chmod 600 "$DEST"/tienda-"$STAMP".db "$DEST"/fotos-"$STAMP".tar.gz

# Borrar copias de más de 14 días
find "$DEST" -type f \( -name 'tienda-*.db' -o -name 'fotos-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete

echo "Copia de seguridad lista: $DEST/tienda-$STAMP.db y fotos-$STAMP.tar.gz"
