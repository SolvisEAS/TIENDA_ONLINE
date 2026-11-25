# API — Todo Herramientas

**Base:** `https://todoherramientas.solvis.com.py/api/v1`
**Clave:** cabecera `Authorization: Bearer <clave>` (se genera en Panel → Configuración → API).
**Formato:** JSON. Límite: 120 llamadas por minuto.

| API | Qué hace |
|---|---|
| `GET /pedidos` | Lista los pedidos |
| `GET /pedidos/{id}` | Muestra un pedido |
| `PATCH /pedidos/{id}` | Modifica los productos y/o el estado de un pedido |
| `GET /productos` | Lista los productos con su stock |
| `GET /productos/{id}` | Muestra el stock de un producto |
| `PUT /productos/{id}/stock` | Fija el stock de un producto |
| `POST /productos/{id}/stock/ajuste` | Suma o resta stock a un producto |
| `GET /stock/movimientos` | Historial de cambios de stock |

---

## GET /pedidos

Lista los pedidos, del más nuevo al más viejo. Sirve para buscar pedidos por estado o fecha.

**Filtros (opcionales):** `estado` (`pendiente`, `confirmado`, `entregado`, `cancelado`, `rechazado`),
`desde` y `hasta` (AAAA-MM-DD), `limite` (50 por defecto, máximo 500).

```
GET /pedidos?estado=pendiente&limite=20
```

**Responde:** una lista de pedidos (cada uno igual que en `GET /pedidos/{id}`).

---

## GET /pedidos/{id}

Muestra un pedido completo. El `id` es el número del mensaje de WhatsApp ("Nuevo pedido #25").

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
  "modificado": false,
  "productos_originales": null,
  "historial": [ { "estado": "pendiente", "fecha": "2026-11-24 10:15:00", "por": "cliente", "nota": null } ]
}
```

- `stock_descontado`: si el stock de este pedido ya se descontó.
- `productos_originales`: lo que el cliente pidió en la web, si el pedido fue modificado.

---

## PATCH /pedidos/{id}

Modifica un pedido: los **productos** (lo que realmente se vendió), el **estado**, o las dos cosas juntas.

```
PATCH /pedidos/25
```

```json
{
  "productos": [ { "producto_id": 36, "cantidad": 1 }, { "producto_id": 41, "cantidad": 1 } ],
  "estado": "confirmado",
  "motivo": "Venta cerrada por WhatsApp"
}
```

- `productos`: lista **completa** de lo vendido (reemplaza la anterior). Se puede quitar, cambiar cantidades
  y agregar productos. Los nuevos van con el precio actual de la web. El total se recalcula; el delivery no cambia.
- `estado`: `pendiente`, `confirmado`, `entregado`, `cancelado` o `rechazado`.
- `motivo`: opcional; queda en el historial.

**Stock — lo maneja la web automáticamente:**

| Caso | Stock |
|---|---|
| Pedido creado en la web | No se descuenta |
| Pasa a `confirmado` o `entregado` | Se descuenta lo que tiene el pedido (una sola vez) |
| Pasa a `pendiente`, `cancelado` o `rechazado` | Se devuelve, si estaba descontado (una sola vez) |
| `confirmado` → `entregado` | No cambia |
| `cancelado` → `rechazado` | No cambia |
| Se modifican los productos de un pedido ya descontado | Se ajusta sólo la diferencia (ej: de 3 a 2 devuelve 1) |

**Responde:**

```json
{ "ok": true, "productos_modificados": true, "cambio_estado": true, "stock": "descontado", "pedido": { ... } }
```

`stock`: `descontado`, `devuelto`, `ajustado` o `sin_cambios`.

**Casos:**
- No hay stock suficiente para confirmar → **409**, y **no se aplica nada** (ni productos ni estado).
- Se manda lo mismo que ya tiene → responde `sin_cambios`.
- Un producto repetido en la lista → se suman las cantidades.
- Lista de productos vacía → **400** (para anular el pedido, usar `estado: cancelado`).

---

## GET /productos

Lista todos los productos con su stock. `?visibles=1` trae sólo los que se ven en la tienda.

```json
[ { "id": 36, "nombre": "TALADRO PERCUTOR MAKITA - 13MM", "categoria": "Herramientas eléctricas", "precio": 450000, "stock": 4, "visible": true } ]
```

## GET /productos/{id}

Muestra un producto y su stock. El `id` es el del enlace del producto (`/producto/36`).

---

## PUT /productos/{id}/stock

Fija el stock en un número exacto. Para inventarios o correcciones.

```json
{ "stock": 10, "motivo": "Inventario" }
```

**Responde:** `{ "ok": true, "producto": { ...stock nuevo... } }`

**Casos:** stock negativo, decimal o vacío → **400**.

---

## POST /productos/{id}/stock/ajuste

Suma (número positivo) o resta (número negativo) unidades. Para mercadería que entra, roturas, ventas fuera de la web.

```json
{ "cantidad": -2, "motivo": "Rotura" }
```

**Responde:** `{ "ok": true, "producto": { ...stock nuevo... } }`

**Casos:**
- Restar más de lo que hay → **409**, el stock no cambia (nunca queda negativo).
- `cantidad` 0 o decimal → **400**.
- **No usar para ventas de pedidos de la web**: esas se descuentan solas al confirmar el pedido
  (usar las dos cosas descontaría dos veces).

---

## GET /stock/movimientos

Historial de cambios de stock. Filtros: `producto` (id), `limite` (100 por defecto, máximo 1000).

```json
[ { "id": 120, "fecha": "2026-11-24 10:20:00", "producto_id": 36, "producto": "TALADRO PERCUTOR MAKITA - 13MM",
    "cambio": -1, "stock_resultante": 3, "origen": "api", "pedido_id": 25, "motivo": "Pedido #25 → confirmado", "por": "API" } ]
```

`cambio` negativo = salió stock, positivo = entró. `origen`: `api` o `panel`.

---

## Errores

Todos responden `{ "error": "mensaje en español" }`.

| Código | Motivo |
|---|---|
| 400 | Datos faltantes o inválidos |
| 401 | Clave incorrecta o faltante |
| 404 | Pedido o producto inexistente |
| 409 | Stock insuficiente (no se aplicó ningún cambio) |
| 429 | Más de 120 llamadas por minuto |
| 503 | API desactivada (no hay clave generada) |
