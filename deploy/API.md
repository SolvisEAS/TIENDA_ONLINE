# API Todo Herramientas

**Dirección:** `https://todoherramientas.solvis.com.py/api/v1`

En los ejemplos, reemplazar `TU_TOKEN` por el token que devuelve el login.

---

## 1. Iniciar sesión (obtener el token)

```bash
curl -X POST https://todoherramientas.solvis.com.py/api/v1/login \
  -H "Content-Type: application/json" \
  -d '{"usuario": "integracion", "contrasena": "TuClaveApi123"}'
```

Respuesta:

```json
{ "token": "k3J9xYz...", "vence": "2026-11-26 10:00", "dura_horas": 24 }
```

El token dura 24 horas. Cuando vence, se vuelve a iniciar sesión.

---

## 2. Ver pedidos

```bash
curl https://todoherramientas.solvis.com.py/api/v1/pedidos \
  -H "Authorization: Bearer TU_TOKEN"
```

Sólo los pendientes:

```bash
curl "https://todoherramientas.solvis.com.py/api/v1/pedidos?estado=pendiente" \
  -H "Authorization: Bearer TU_TOKEN"
```

Respuesta: una lista de pedidos (cada uno igual al del punto 3).

---

## 3. Ver un pedido

```bash
curl https://todoherramientas.solvis.com.py/api/v1/pedidos/25 \
  -H "Authorization: Bearer TU_TOKEN"
```

Respuesta:

```json
{
  "id": 25,
  "estado": "pendiente",
  "cliente": { "nombre": "Juan Pérez", "telefono": "0981123456" },
  "productos": [ { "producto_id": 36, "nombre": "Taladro", "cantidad": 2, "precio_unitario": 450000 } ],
  "total": 925000
}
```

El número del pedido es el mismo que llega por WhatsApp ("Nuevo pedido #25").

---

## 4. Modificar un pedido

Deja el pedido con lo que realmente se vendió y le cambia el estado.

```bash
curl -X PATCH https://todoherramientas.solvis.com.py/api/v1/pedidos/25 \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productos": [{"producto_id": 36, "cantidad": 1}], "estado": "confirmado"}'
```

Sólo cambiar el estado:

```bash
curl -X PATCH https://todoherramientas.solvis.com.py/api/v1/pedidos/25 \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"estado": "entregado"}'
```

Respuesta:

```json
{ "ok": true, "stock": "descontado", "pedido": { ... } }
```

- `productos`: lo que se vendió (la lista completa). Se puede quitar, cambiar cantidades o agregar.
- `estado`: `pendiente`, `confirmado`, `entregado`, `cancelado` o `rechazado`.

**El stock lo descuenta la web sola:** al pasar a `confirmado` o `entregado` descuenta lo que tiene el pedido;
al pasar a `cancelado` o `rechazado` lo devuelve. Siempre una sola vez.

---

## 5. Ver stock

Todos los productos:

```bash
curl https://todoherramientas.solvis.com.py/api/v1/productos \
  -H "Authorization: Bearer TU_TOKEN"
```

Un producto:

```bash
curl https://todoherramientas.solvis.com.py/api/v1/productos/36 \
  -H "Authorization: Bearer TU_TOKEN"
```

Respuesta:

```json
{ "id": 36, "nombre": "Taladro", "precio": 450000, "stock": 4 }
```

---

## 6. Cambiar el stock

Para inventarios, mercadería que llega o roturas. **No usar para las ventas de los pedidos** (esas las descuenta la web sola).

Poner un número exacto:

```bash
curl -X PUT https://todoherramientas.solvis.com.py/api/v1/productos/36/stock \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"stock": 10}'
```

Sumar o restar (negativo para restar):

```bash
curl -X POST https://todoherramientas.solvis.com.py/api/v1/productos/36/stock/ajuste \
  -H "Authorization: Bearer TU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cantidad": -2}'
```

Respuesta:

```json
{ "ok": true, "producto": { "id": 36, "nombre": "Taladro", "stock": 8 } }
```

---

## 7. Ver los cambios de stock

```bash
curl "https://todoherramientas.solvis.com.py/api/v1/stock/movimientos?producto=36" \
  -H "Authorization: Bearer TU_TOKEN"
```

---

## Si algo sale mal

La respuesta trae el motivo: `{ "error": "..." }`

| Código | Significa |
|---|---|
| 400 | Faltan datos o están mal |
| 401 | Usuario o contraseña incorrectos, o el token venció (iniciar sesión de nuevo) |
| 404 | El pedido o producto no existe |
| 409 | No hay stock suficiente (no se hizo ningún cambio) |
| 429 | Demasiadas llamadas: máximo 120 por minuto |
