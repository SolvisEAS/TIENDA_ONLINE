# API de Todo Herramientas

API para que un sistema externo **cambie el estado de los pedidos** de la tienda web y **lea o modifique el stock**.

- **Dirección base:** `https://todoherramientas.solvis.com.py/api/v1`
- **Formato:** JSON (enviar la cabecera `Content-Type: application/json` en `PUT`, `PATCH` y `POST`).
- **Límite:** 120 llamadas por minuto.

## Clave de acceso

La clave se genera en el panel: **Configuración → API para sistemas externos → Generar clave**.
Se muestra **una sola vez**; si se pierde, se genera otra (la anterior deja de funcionar).

Enviarla en cada llamada con una de estas cabeceras:

```
Authorization: Bearer th_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
```
X-API-Key: th_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Cómo se mueve el stock con los pedidos

Cuando un cliente hace un pedido en la web, el pedido queda **Pendiente** y el stock **todavía no se descuenta**
(sólo se revisa que haya stock suficiente). El stock se mueve al cambiar el estado:

| El pedido pasa a…                    | Stock                                                         |
|--------------------------------------|---------------------------------------------------------------|
| `confirmado` o `entregado`           | Se **descuenta**, si todavía no estaba descontado             |
| `pendiente`, `cancelado` o `rechazado` | Se **devuelve**, si estaba descontado                       |

Cada pedido tiene la marca `stock_descontado` (`true`/`false`). **El stock se descuenta y se devuelve una sola vez**,
pase el pedido por los estados que pase. Ejemplos:

- `pendiente → confirmado`: descuenta. Después `confirmado → entregado`: no cambia (ya estaba descontado).
- `confirmado → cancelado`: devuelve. Después `cancelado → rechazado`: no cambia (ya se había devuelto).
- `cancelado → confirmado`: vuelve a descontar (si hay stock).

Si al confirmar no alcanza el stock, la API responde **409** y el pedido **no cambia**.

Los mismos cambios hechos a mano desde el panel siguen exactamente la misma regla.

---

## Pedidos

### Ver la lista de pedidos

```
GET /pedidos?estado=pendiente&desde=2026-11-01&hasta=2026-11-30&limite=50
```

Todos los filtros son opcionales. `estado`: `pendiente`, `confirmado`, `entregado`, `cancelado`, `rechazado`.
`limite`: hasta 500 (50 por defecto). Ordenados del más nuevo al más viejo.

### Ver un pedido

```
GET /pedidos/25
```

Respuesta:

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
    { "producto_id": 36, "nombre": "TALADRO PERCUTOR MAKITA - 13MM", "cantidad": 1, "precio_unitario": 450000, "subtotal": 450000 }
  ],
  "subtotal": 450000,
  "delivery": 25000,
  "total": 475000,
  "notas": null,
  "motivo_rechazo": null,
  "entregado_el": null,
  "historial": [ { "estado": "pendiente", "fecha": "2026-11-24 10:15:00", "por": "cliente", "nota": null } ]
}
```

El número de pedido es el mismo que aparece en el mensaje de WhatsApp (*"Nuevo pedido #25"*).

### Cambiar el estado de un pedido

```
PATCH /pedidos/25
{ "estado": "confirmado", "motivo": "Venta confirmada por WhatsApp" }
```

`motivo` es opcional (en `rechazado` se guarda como motivo del rechazo). Respuesta:

```json
{ "ok": true, "cambio_estado": true, "stock": "descontado", "pedido": { ... } }
```

`stock` indica qué pasó: `descontado`, `devuelto` o `sin_cambios`.

---

## Stock

### Ver todos los productos / uno

```
GET /productos            (todos)
GET /productos?visibles=1 (sólo los visibles en la tienda)
GET /productos/36
```

```json
{ "id": 36, "nombre": "TALADRO PERCUTOR MAKITA - 13MM", "categoria": "Herramientas eléctricas", "precio": 450000, "stock": 4, "visible": true }
```

El `id` es el número del producto en la web (el mismo de `https://todoherramientas.solvis.com.py/producto/36`).

### Fijar el stock

```
PUT /productos/36/stock
{ "stock": 10, "motivo": "Inventario" }
```

### Sumar o restar stock

```
POST /productos/36/stock/ajuste
{ "cantidad": -2, "motivo": "Venta en el local" }
```

`cantidad` negativa resta y positiva suma. Si se quiere restar más de lo que hay, responde **409** y no cambia nada
(el stock nunca queda negativo).

### Historial de movimientos de stock

```
GET /stock/movimientos?producto=36&limite=100
```

Cada cambio de stock queda anotado: por pedidos, por la API o desde el panel.

```json
[ { "id": 120, "fecha": "2026-11-24 10:20:00", "producto_id": 36, "producto": "TALADRO PERCUTOR MAKITA - 13MM",
    "cambio": -1, "stock_resultante": 3, "origen": "api", "pedido_id": 25, "motivo": "Pedido #25 → confirmado", "por": "API" } ]
```

---

## Errores

Siempre con un mensaje en español: `{ "error": "..." }`

| Código | Significa |
|---|---|
| 400 | Faltan datos o no son válidos |
| 401 | Clave de API inválida o faltante |
| 404 | El pedido o producto no existe |
| 409 | No hay stock suficiente (el cambio no se aplicó) |
| 429 | Más de 120 llamadas por minuto |
| 503 | La API está desactivada (no hay clave generada) |

## Ejemplo completo (curl)

```bash
curl -X PATCH https://todoherramientas.solvis.com.py/api/v1/pedidos/25 \
  -H "Authorization: Bearer th_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"estado": "confirmado", "motivo": "Venta confirmada por WhatsApp"}'
```
