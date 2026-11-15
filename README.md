# Tienda online (versión local)

Tienda con panel para el comerciante y catálogo con carrito para los clientes.
Los pedidos se guardan en la base de datos y se envían por WhatsApp al número del local.

## Cómo iniciarla

Requiere Node.js 22.13 o superior.

```bash
npm install
npm start
```

- Tienda: http://localhost:3000
- Panel: http://localhost:3000/admin (se ingresa con usuario y contraseña)

### Acceso al panel

- Desde el panel, en **Configuración**, el usuario puede cambiar su contraseña.
- Después de 5 intentos fallidos seguidos, el ingreso se bloquea 10 minutos para esa conexión.
- **Si el usuario pierde el acceso**, se resetea desde la terminal, en la PC (o servidor) donde corre la tienda:

  ```bash
  npm run resetear-clave -- lucassanabria
  ```

  Genera una contraseña nueva al azar, la muestra en pantalla y cierra las sesiones abiertas de ese usuario.
  Para elegir vos la contraseña: `npm run resetear-clave -- lucassanabria MiClaveNueva123`.
  Sin datos (`npm run resetear-clave`) muestra la lista de usuarios. No crea usuarios nuevos
  (sólo el primero, si la base de datos está vacía).

### Reportes

Pestaña **Reportes**: total vendido (sólo pedidos **entregados**, en la fecha de entrega), ticket promedio,
unidades, pendiente de entrega, gráfico de ventas, pedidos por estado, ventas por categoría,
productos más vendidos, lista de pedidos y stock. Botón **Descargar Excel** con 4 hojas.

Estados de un pedido: Pendiente, Confirmado, Entregado, Cancelado (el cliente no siguió) y
Rechazado (la tienda no puede cumplirlo, con motivo opcional). Cancelado y Rechazado devuelven el stock.

Para probar desde el celular, conectalo a la misma red WiFi y abrí la dirección
"Desde el celular" que aparece en la consola al iniciar.

## Qué hace

**Panel (`/admin`)**
- Productos: alta, edición y borrado con hasta 8 fotos (la primera es la principal), precio, precio anterior (oferta), categoría, stock,
  "visible en la tienda" y "destacado" (aparece en el banner principal).
  El stock se puede cambiar directo desde la lista. Arriba hay un resumen: cantidad de productos,
  valor del stock, productos con stock bajo y sin stock (tocando cada uno se filtra la lista).
- Pedidos: lista filtrable por estado (pendiente, confirmado, entregado, cancelado).
  Al cancelar un pedido se repone el stock.
- Precios de delivery (en Configuración): lista de ciudades con su precio, más el precio de "Otros".
  Con envío a domicilio, el cliente busca su ciudad escribiendo; si no está, elige "Otros" y la escribe.
  El delivery se suma al total. El cliente puede marcar "Necesito factura" e ingresar su Ruc/CI.
- Configuración: nombre de la tienda, moneda, dirección, mensaje de la barra superior,
  número de WhatsApp, envío/retiro, franjas horarias,
  duración de cada turno, pedidos máximos por turno, anticipación mínima y días cerrados.

**Tienda (`/`)**
- Catálogo con filtro por categoría; no deja agregar más unidades que el stock.
- Cada producto tiene su propia página (`/producto/<número>`) con galería de fotos, foto ampliada,
  descripción completa, cantidad, "Comprar ahora", consulta por WhatsApp y productos relacionados.
- Carrito guardado en el navegador del cliente.
- El cliente elige envío o retiro, día y horario (sólo los turnos libres).
- Al confirmar: se registra el pedido, se descuenta el stock y se abre WhatsApp con el
  mensaje ya escrito para el local. El cliente sólo tiene que tocar "Enviar".

## Publicarla en un servidor

La guía paso a paso para UpCloud (Ubuntu + Nginx + HTTPS en `todoherramientas.solvis.com.py`)
está en [deploy/GUIA-UPCLOUD.md](deploy/GUIA-UPCLOUD.md), junto con el servicio de systemd,
la configuración de Nginx, la copia de seguridad diaria y el script para actualizar.

## Dónde quedan los datos

- `data/tienda.db`: base de datos SQLite (productos, pedidos, configuración).
- `uploads/`: fotos de los productos.

Para hacer una copia de seguridad, copiá esas dos carpetas con el servidor apagado.
