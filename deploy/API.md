# API de Todo Herramientas

API para que un sistema externo **modifique los pedidos** de la tienda web (productos vendidos y estado)
y **consulte el stock**. La API **no modifica el stock directamente**: el stock lo mueve la web sola,
según el estado de cada pedido.

- **Dirección base:** `https://todoherramientas.solvis.com.py/api/v1`
- **Formato:** JSON. En `PATCH` enviar la cabecera `Content-Type: application/json`.
- **Límite:** 120 llamadas por minuto.

## Clave de acceso

Se genera en el panel: **Configuración → API para sistemas externos → Generar clave**.
Se muestra **una sola vez**; si se pierde, se genera otra (la anterior deja de funcionar).

Enviarla en cada llamada:

```
Authorization: Bearer th_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

(también se acepta la cabecera `X-API-Key: th_xxxx...`)

---

## Cómo funciona (leer antes de integrar)

1. El cliente hace un pedido en la web → queda **`pendiente`**. **El stock no se descuenta todavía.**
2. La venta se cierra por WhatsApp. Si cambió algo (otra cantidad, un producto menos, uno más),
   su sistema **modifica el pedido** con lo que realmente se vendió.
3. Su sistema pasa el pedido a **`confirmado`** (o `entregado`) → **la web descuenta el stock automáticamente**,
   según los productos que tiene el pedido en ese momento.
4. Si la venta no se concreta → pasan el pedido a **`cancelado`** o **`rechazado`** → si el stock estaba descontado,
   **la web lo devuelve automáticamente**.

**El stock se descuenta y se devuelve una sola vez.** Cada pedido tiene la marca `stock_descontado`:

| El pedido pasa a…                      | Stock                                             |
|----------------------------------------|---------------------------------------------------|
| `confirmado` o `entregado`             | Se descuenta, si todavía no estaba descontado     |
| `pendiente`, `cancelado` o `rechazado` | Se devuelve, si estaba descontado                 |
| `confirmado` → `entregado`             | No cambia (ya estaba descontado)                  |
| `cancelado` → `rechazado`              | No cambia (ya se había devuelto)                  |

Si se modifican los productos de un pedido que **ya tiene el stock descontado**, la web ajusta **sólo la diferencia**
(ej: de 3 unidades a 2 devuelve 1).

> **Orden recomendado:** modificar los productos y cambiar el estado **en la misma llamada** (ver ejemplo abajo).
> Así nunca queda un pedido confirmado con productos viejos.

Los reportes de la web se calculan con los productos del pedido, por eso es importante que el pedido refleje
**lo que realmente se vendió**.

---

## Pedidos

### Ver la lista de pedidos

```
GET /pedidos?estado=pendiente&desde=2026-11-01&hasta=2026-11-30&limite=50
```

Filtros opcionales. `estado`: `pendiente`, `confirmado`, `entregado`, `cancelado`, `rechazado`.
`limite`: hasta 500 (50 por defecto). Del más nuevo al más viejo.

### Ver un pedido

```
GET /pedidos/25
```

```json
{
  "id": 25,
  "estado": "pendiente",
  "stock_descontado": false,
  "creado": "2026-11-24 10:15:00",
  "cliente": { "nombre": "Juan Pérez", "telefono": "0981123456" },
  "entrega": { "tipo": "envio", "ciudad": "Asunción", "direccion": "Calle 1", "dia": "2026-11-25", "hora": "09:30" },
  "factura": { "necesita": true, "ruc": "80012345-6" },
  "productos": [
    { "producto_id": 36, "nombre": "TALADRO PERCUTOR MAKITA - 13MM", "cantidad": 2, "precio_unitario": 450000, "subtotal": 900000 }
  ],
  "subtotal": 900000,
  "delivery": 25000,
  "total": 925000,
  "notas": null,
  "motivo_rechazo": null,
  "entregado_el": null,
  "modificado": false,
  "productos_originales": null,
  "historial": [ { "estado": "pendiente", "fecha": "2026-11-24 10:15:00", "por": "cliente", "nota": null } ]
}
```

El número de pedido es el mismo del mensaje de WhatsApp (*"Nuevo pedido #25"*).
Si el pedido fue modificado, `productos_originales` muestra lo que el cliente pidió en la web.

### Modificar un pedido

```
PATCH /pedidos/25
```

Se puede mandar **`productos`**, **`estado`** o **las dos cosas**:

```json
{
  "productos": [
    { "producto_id": 36, "cantidad": 1 },
    { "producto_id": 41, "cantidad": 1 }
  ],
  "estado": "confirmado",
  "motivo": "Venta cerrada por WhatsApp"
}
```

- **`productos`**: la lista **completa** de lo que se vendió (reemplaza a la anterior). Se pueden quitar productos,
  cambiar cantidades y **agregar** productos nuevos (van con el precio actual de la web; los que ya estaban
  mantienen su precio). El total se recalcula; el delivery no cambia.
- **`estado`**: el estado nuevo.
- **`motivo`**: opcional. En `rechazado` se guarda como motivo del rechazo.

Respuesta:

```json
{ "ok": true, "productos_modificados": true, "cambio_estado": true, "stock": "descontado", "pedido": { ... } }
```

`stock` indica qué hizo la web: `descontado`, `devuelto`, `ajustado` (se corrigió la diferencia) o `sin_cambios`.

Si algo falla (por ejemplo, no hay stock para confirmar), **no se aplica nada**: ni los productos ni el estado.

---

## Stock (sólo consulta)

```
GET /productos             (todos)
GET /productos?visibles=1  (sólo los visibles en la tienda)
GET /productos/36
```

```json
{ "id": 36, "nombre": "TALADRO PERCUTOR MAKITA - 13MM", "categoria": "Herramientas eléctricas", "precio": 450000, "stock": 4, "visible": true }
```

El `id` es el número del producto en la web (`https://todoherramientas.solvis.com.py/producto/36`).

### Historial de movimientos de stock

```
GET /stock/movimientos?producto=36&limite=100
```

```json
[ { "id": 120, "fecha": "2026-11-24 10:20:00", "producto_id": 36, "producto": "TALADRO PERCUTOR MAKITA - 13MM",
    "cambio": -1, "stock_resultante": 3, "origen": "api", "pedido_id": 25, "motivo": "Pedido #25 → confirmado", "por": "API" } ]
```

---

## Errores

Siempre con un mensaje en español: `{ "error": "..." }`

| Código | Significa |
|---|---|
| 400 | Faltan datos o no son válidos (estado, producto, cantidad) |
| 401 | Clave de API inválida o faltante |
| 404 | El pedido o producto no existe |
| 409 | No hay stock suficiente: **no se aplicó ningún cambio** |
| 429 | Más de 120 llamadas por minuto |
| 503 | La API está desactivada (no hay clave generada) |

## Ejemplo completo (curl)

```bash
curl -X PATCH https://todoherramientas.solvis.com.py/api/v1/pedidos/25 \
  -H "Authorization: Bearer th_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"productos":[{"producto_id":36,"cantidad":1}],"estado":"confirmado","motivo":"Venta cerrada por WhatsApp"}'
```
