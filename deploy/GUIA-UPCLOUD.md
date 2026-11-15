# Subir la tienda a UpCloud

Resultado final: **https://todoherramientas.solvis.com.py** (con candado HTTPS), funcionando las 24 horas,
con copia de seguridad diaria.

Cómo queda armado en el servidor:

```
Visitante ──HTTPS──> Nginx (puertos 80/443) ──> Tienda Node.js (127.0.0.1:3010) ──> data/ y uploads/
```

En los comandos reemplazá:

| Texto | Por |
|---|---|
| `IP_DEL_SERVIDOR` | La IP pública del servidor (está en el panel de UpCloud, en "IP addresses") |

Los comandos con fondo gris se copian y pegan **en el servidor** (después de conectarte por SSH),
salvo donde dice **"en tu PC"**.

> **Servidor compartido con otros sistemas** (como el de Solvis: crm, odoo, panel, wa, clínica):
> NO ejecutar `apt upgrade`, NO reinstalar Nginx ni Node.js (sirve Node 22.13 o superior),
> NO tocar el firewall ni borrar sitios de Nginx. La tienda usa el puerto **3010** (el 3000 ya está ocupado).

---

## Paso 0 — Apuntar el subdominio al servidor (en el DNS de solvis.com.py)

Entrá al lugar donde administrás el dominio **solvis.com.py** (NIC.py, Cloudflare, el hosting, etc.)
y creá este registro:

| Tipo | Nombre | Valor | TTL |
|---|---|---|---|
| `A` | `todoherramientas` | `IP_DEL_SERVIDOR` | Automático / 3600 |

- Si usás **Cloudflare**, dejá la nube en **gris ("DNS only")** al menos hasta terminar el paso 7.
- El cambio puede tardar de minutos a unas horas. Para comprobarlo, **en tu PC** (PowerShell):

  ```powershell
  nslookup todoherramientas.solvis.com.py
  ```

  Tiene que responder con la IP del servidor.

---

## Paso 1 — Conectarte y preparar el servidor

**En tu PC** (PowerShell o la terminal de VS Code):

```powershell
ssh root@IP_DEL_SERVIDOR
```

Ya en el servidor, actualizar e instalar lo necesario:

```bash
apt update && apt upgrade -y
apt install -y nginx git ufw ca-certificates curl
```

Instalar Node.js 24 (la misma versión que usás en tu PC):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -v
```

Tiene que mostrar `v24...`.

Firewall: sólo SSH y la web.

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status
```

> Si en el panel de UpCloud tenés activado su "Firewall", abrí también ahí los puertos 22, 80 y 443.

---

## Paso 2 — Crear el usuario de la tienda

La tienda corre con su propio usuario, sin permisos de administrador:

```bash
adduser --system --group --home /home/tienda --shell /bin/bash tienda
mkdir -p /opt/tienda-online
chown tienda:tienda /opt/tienda-online
```

---

## Paso 3 — Dar acceso al repositorio privado de GitHub

El repositorio es privado, así que el servidor necesita una "llave de solo lectura" (deploy key):

```bash
sudo -u tienda mkdir -p -m 700 /home/tienda/.ssh
sudo -u tienda ssh-keygen -t ed25519 -N "" -f /home/tienda/.ssh/id_ed25519 -C "servidor-upcloud-tienda"
sudo -u tienda cat /home/tienda/.ssh/id_ed25519.pub
```

Copiá la línea que empieza con `ssh-ed25519 ...` y en GitHub:

1. Entrá a **https://github.com/SolvisEAS/TIENDA_ONLINE/settings/keys**
2. **Add deploy key**
3. Title: `Servidor UpCloud` — Key: pegá la línea — **NO** marques "Allow write access".
4. **Add key**

Probar la conexión (la primera vez pregunta si confiás en GitHub: escribí `yes`):

```bash
sudo -u tienda ssh -T git@github.com
```

Tiene que decir *"Hi SolvisEAS/TIENDA_ONLINE! You've successfully authenticated..."*.

---

## Paso 4 — Descargar la tienda e instalarla

```bash
sudo -u tienda git clone git@github.com:SolvisEAS/TIENDA_ONLINE.git /opt/tienda-online
cd /opt/tienda-online
sudo -u tienda npm ci --omit=dev --no-fund --no-audit
sudo -u tienda mkdir -p data uploads
chmod +x deploy/*.sh
```

---

## Paso 5 — Pasar tus productos, fotos y pedidos (desde tu PC)

> Si preferís arrancar la tienda **vacía**, saltá al final de este paso.

1. **En tu PC, detené la tienda** (en VS Code: Shift + F5), así la base de datos queda cerrada.
2. **En tu PC**, en PowerShell, copiá las dos carpetas al servidor:

   ```powershell
   scp -r "C:\Users\evero\Documents\SOLVIS EAS\TIENDA_ONLINE\data" "C:\Users\evero\Documents\SOLVIS EAS\TIENDA_ONLINE\uploads" root@IP_DEL_SERVIDOR:/opt/tienda-online/
   ```

3. **En el servidor**, darle esas carpetas al usuario de la tienda:

   ```bash
   chown -R tienda:tienda /opt/tienda-online/data /opt/tienda-online/uploads
   chmod 750 /opt/tienda-online/data
   ```

Tu usuario y contraseña del panel siguen siendo los mismos que en tu PC.

**Si arrancás vacía**, creá el usuario del panel (te muestra la contraseña generada):

```bash
cd /opt/tienda-online && sudo -u tienda npm run resetear-clave -- todoherramientas
```

---

## Paso 6 — Dejar la tienda funcionando siempre

```bash
cp /opt/tienda-online/deploy/tienda.service /etc/systemd/system/tienda.service
systemctl daemon-reload
systemctl enable --now tienda
systemctl status tienda --no-pager
```

Tiene que decir **active (running)**. Prueba rápida dentro del servidor:

```bash
curl -s http://127.0.0.1:3010/api/store | head -c 200; echo
```

---

## Paso 7 — Nginx y HTTPS

```bash
cp /opt/tienda-online/deploy/nginx-tienda.conf /etc/nginx/sites-available/tienda
ln -s /etc/nginx/sites-available/tienda /etc/nginx/sites-enabled/tienda
nginx -t && systemctl reload nginx
```

Ya debería abrir **http://todoherramientas.solvis.com.py** (todavía sin candado).

Ahora el certificado HTTPS gratuito (se renueva solo):

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d todoherramientas.solvis.com.py --redirect -m TU_CORREO --agree-tos --no-eff-email
```

(En `TU_CORREO` poné un correo tuyo: Let's Encrypt avisa ahí si algo falla con el certificado.)

Comprobar que la renovación automática funciona:

```bash
certbot renew --dry-run
```

Listo: **https://todoherramientas.solvis.com.py** y el panel en **https://todoherramientas.solvis.com.py/admin**

---

## Paso 8 — Revisar que todo ande

- Abrí la tienda en el celular (con datos móviles, no WiFi) y verificá el candado.
- Entrá al panel, revisá productos, pedidos y reportes.
- Hacé un pedido de prueba, comprobá que llega el WhatsApp y después cancelalo desde el panel.

---

## Paso 9 — Copias de seguridad automáticas

Probar a mano:

```bash
/opt/tienda-online/deploy/backup.sh
ls -lh /var/backups/tienda
```

Programarla todos los días a las 3:00:

```bash
echo "0 3 * * * root /opt/tienda-online/deploy/backup.sh >> /var/log/tienda-backup.log 2>&1" > /etc/cron.d/tienda-backup
```

Guarda los últimos 14 días en `/var/backups/tienda`. Para tener también una copia **fuera** del servidor,
desde tu PC de vez en cuando:

```powershell
scp -r root@IP_DEL_SERVIDOR:/var/backups/tienda "$HOME\Desktop\backups-tienda"
```

> Recomendado además: activar los **Backups** del servidor en el panel de UpCloud.

---

## Uso diario

**Subir cambios nuevos** (después de hacer `git push` desde tu PC):

```bash
/opt/tienda-online/deploy/actualizar.sh
```

Hace una copia de seguridad, descarga lo nuevo de GitHub, instala y reinicia la tienda.

**Resetear la contraseña del panel:**

```bash
cd /opt/tienda-online && sudo -u tienda npm run resetear-clave -- todoherramientas
```

**Ver si la tienda está funcionando / ver errores:**

```bash
systemctl status tienda --no-pager
journalctl -u tienda -n 100 --no-pager
```

**Reiniciar la tienda:**

```bash
systemctl restart tienda
```

---

## Si algo falla

| Problema | Qué revisar |
|---|---|
| La página no abre | `systemctl status tienda` y `systemctl status nginx`. ¿El DNS ya apunta a la IP? (`nslookup`) |
| "502 Bad Gateway" | La tienda no está corriendo: `journalctl -u tienda -n 50 --no-pager` |
| Certbot falla | El DNS todavía no apunta al servidor, o el puerto 80 está cerrado (ufw / firewall de UpCloud) |
| `git pull` falla | La deploy key: `sudo -u tienda ssh -T git@github.com` |
| No se pueden subir fotos | Permisos: `chown -R tienda:tienda /opt/tienda-online/uploads` |
| Error de permisos en la base de datos | `chown -R tienda:tienda /opt/tienda-online/data` |
