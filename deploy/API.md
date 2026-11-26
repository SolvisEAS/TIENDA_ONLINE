# API Todo Herramientas

**Dirección:** `https://todoherramientas.solvis.com.py/api/v1`

---

## Cómo conectarse

**Paso 1 — Pedir un token** con el usuario y la contraseña de la API:

```
POST /login
{ "usuario": "integracion", "contrasena": "Api-xxxxx-xxxxx" }
```

Se recibe:

```
{ "token": "k3J9...", "vence": "2026-11-26 10:00" }
```

**Paso 2 — Usar el token** en todas las demás llamadas, en esta cabecera:

```
Authorization: Bearer k3J9...
```

El token dura **24 horas**. Cuando vence, se pide otro (paso 1).

---

## Pedidos

### Ver pedidos

```
GET /pedidos
GET /pedidos?estado=pendiente
```

Filtros opcionales: `estado`, `desde` y `hasta` (fechas AAAA-MM-DD).

### Ver un pedido

```
GET /pedidos/25
```

Se recibe el pedido con el cliente, la entrega, los productos y el total:

```
{
  "id": 25,
  "estado": "pendiente",
  "cliente": { "nombre": "Juan Pérez", "telefono": "0981123456" },
  "productos": [ { "producto_id": 36, "nombre": "Taladro", "cantidad": 2, "precio_unitario": 450000 } ],
  "total": 925000
}
```

El número del pedido es el mismo que llega por WhatsApp ("Nuevo pedido #25").

### Modificar un pedido

Sirve para dejar el pedido con **lo que realmente se vendió** y cambiarle el **estado**.

```
PATCH /pedidos/25
{
  "productos": [ { "producto_id": 36, "cantidad": 1 } ],
  "estado": "confirmado"
}
```

- `productos`: lo que se vendió (la lista completa). Se puede quitar, cambiar cantidades o agregar.
- `estado`: `pendiente`, `confirmado`, `entregado`, `cancelado` o `rechazado`.
- Se puede mandar uno solo o los dos juntos.

**El stock lo descuenta la web sola:**

- Al pasar a **confirmado** o **entregado** → descuenta lo que tiene el pedido.
- Al pasar a **cancelado** o **rechazado** → lo devuelve.
- Siempre **una sola vez**, aunque el pedido cambie de estado varias veces.

---

## Stock

### Ver stock

```
GET /productos
GET /productos/36
```

Se recibe:

```
{ "id": 36, "nombre": "Taladro", "precio": 450000, "stock": 4 }
```

### Cambiar el stock

Para inventarios, mercadería que llega o roturas. **No usar para las ventas de los pedidos** (esas las descuenta la web sola).

Poner un número exacto:

```
PUT /productos/36/stock
{ "stock": 10 }
```

Sumar o restar:

```
POST /productos/36/stock/ajuste
{ "cantidad": -2 }
```

### Ver los cambios de stock

```
GET /stock/movimientos?producto=36
```

---

## Si algo sale mal

La respuesta trae el motivo: `{ "error": "..." }`

| Código | Significa |
|---|---|
| 400 | Faltan datos o están mal |
| 401 | Usuario o contraseña incorrectos, o el token venció (pedir uno nuevo) |
| 404 | El pedido o producto no existe |
| 409 | No hay stock suficiente (no se hizo ningún cambio) |
| 429 | Demasiadas llamadas: máximo 120 por minuto |
