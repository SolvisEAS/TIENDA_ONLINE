# Guía de la API de Todo Herramientas

## ¿Qué es esto?

Una **API** es una "puerta" para que **otro sistema** (por ejemplo, el programa de ventas del negocio o un bot
de WhatsApp) pueda comunicarse con la tienda web **sin entrar al panel**. Con esta API se puede:

| Qué | Para qué sirve |
|---|---|
| **Ver pedidos** | Saber qué pidieron los clientes en la web |
| **Modificar pedidos** | Dejar el pedido igual a lo que **realmente se vendió** y cambiarle el estado (confirmado, entregado, cancelado…) |
| **Ver stock** | Consultar cuántas unidades hay de cada producto |
| **Modificar stock** *(opcional)* | Corregir el stock por inventario, mercadería que entra, roturas, etc. |
| **Ver movimientos de stock** | Ver cada cambio de stock: cuándo, cuánto y por qué |

> La API la usa un **programador** desde otro sistema. Esta guía tiene primero la explicación general
> y después, en cada parte, el detalle técnico con ejemplos.

---

## Lo más importante: cómo se mueve el stock con los pedidos

**El stock lo descuenta la web sola**, en el momento justo. No hace falta usar la API de stock para las ventas.

1. **El cliente hace un pedido en la web** → el pedido queda **Pendiente**.
   El stock **todavía no se descuenta** (sólo se revisa que haya).
2. **La venta se arregla por WhatsApp.** Si el cliente cambió algo (llevó menos, más, u otro producto),
   el sistema **modifica el pedido** para que diga **lo que realmente se vendió**.
3. **El pedido pasa a Confirmado o Entregado** → **la web descuenta el stock automáticamente**,
   según lo que dice el pedido en ese momento.
4. **Si la venta no se hace** → el pedido pasa a **Cancelado** o **Rechazado** → si el stock ya se había
   descontado, **la web lo devuelve automáticamente**.

### El stock se descuenta y se devuelve UNA sola vez

Cada pedido "recuerda" si su stock ya está descontado. Por eso, aunque el pedido cambie de estado
varias veces, el stock nunca se descuenta ni se devuelve dos veces:

| El pedido pasa de… | Qué pasa con el stock |
|---|---|
| Pendiente → **Confirmado** | Se **descuenta** |
| Confirmado → **Entregado** | Nada (ya estaba descontado) |
| Entregado → **Cancelado** | Se **devuelve** |
| Cancelado → **Rechazado** | Nada (ya se había devuelto) |
| Cancelado → **Confirmado** | Se vuelve a **descontar** |

Y si se modifican los productos de un pedido que **ya tiene el stock descontado**, la web corrige
**sólo la diferencia**. Ejemplo: el pedido tenía 3 taladros y se corrige a 2 → la web devuelve 1.

### ¿Por qué es importante modificar el pedido?

Los **reportes de ventas** de la web (total vendido, productos más vendidos, etc.) se calculan con los
pedidos. Si el pedido dice 3 pero se vendieron 2, el reporte estaría mal. Por eso el pedido siempre tiene
que quedar con **lo que realmente se vendió**. La web guarda igual **lo que el cliente pidió originalmente**,
como respaldo.

---

## Antes de empezar

### Dirección

Todas las llamadas empiezan con:

```
https://todoherramientas.solvis.com.py/api/v1
```

### La clave (contraseña de la API)

La API está protegida con una **clave secreta**. Sin la clave, nadie puede usarla.

- **Dónde se genera:** en el panel → **Configuración → API para sistemas externos → Generar clave**.
- **Se muestra una sola vez.** Hay que copiarla y guardarla en un lugar seguro.
- **Si se pierde o se filtra:** se genera una nueva desde el mismo lugar; la anterior deja de funcionar al instante.
- **Para apagar la API:** botón **Desactivar la API**.

En cada llamada, el programa tiene que mandar la clave en esta cabecera:

```
Authorization: Bearer th_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

(También se acepta `X-API-Key: th_xxxx...`.)

### Otras reglas

- Los datos van y vienen en formato **JSON**. Al enviar datos, agregar la cabecera `Content-Type: application/json`.
- Máximo **120 llamadas por minuto**.
- Si algo sale mal, la respuesta trae un mensaje **en español** explicando el motivo (ver "Errores" al final).

---

## 1. Ver pedidos

### Ver la lista de pedidos

**Para qué:** consultar los pedidos de la web, por ejemplo los que están pendientes de confirmar.

```
GET /pedidos
GET /pedidos?estado=pendiente
GET /pedidos?desde=2026-11-01&hasta=2026-11-30&limite=100
```

Filtros (todos opcionales):

| Filtro | Qué hace |
|---|---|
| `estado` | Sólo los pedidos en ese estado: `pendiente`, `confirmado`, `entregado`, `cancelado` o `rechazado` |
| `desde` / `hasta` | Sólo los pedidos hechos entre esas fechas (formato AAAA-MM-DD) |
| `limite` | Cuántos pedidos traer (50 si no se indica, máximo 500) |

Vienen del más nuevo al más viejo.

### Ver un pedido

**Para qué:** ver todo el detalle de un pedido. El número es el mismo que aparece en el mensaje de WhatsApp
(*"Nuevo pedido #25"*).

```
GET /pedidos/25
```

Respuesta (ejemplo):

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

Qué significa cada dato importante:

| Dato | Significado |
|---|---|
| `estado` | En qué etapa está el pedido |
| `stock_descontado` | `true` si el stock de este pedido ya se descontó |
| `productos` | Lo que tiene el pedido **ahora** (lo vendido, si fue modificado) |
| `modificado` / `productos_originales` | Si fue modificado, lo que el cliente pidió originalmente en la web |
| `historial` | Cada cambio del pedido: estado, fecha y quién lo hizo (`cliente`, `API` o el usuario del panel) |

---

## 2. Modificar un pedido

**Para qué:** dejar el pedido con lo que realmente se vendió y/o cambiarle el estado.

```
PATCH /pedidos/25
```

Se puede mandar **los productos**, **el estado** o **las dos cosas juntas**.

### Ejemplo: se vendió distinto y se confirma (lo más común)

El cliente pidió 2 taladros, pero por WhatsApp terminó llevando 1 taladro y 1 caja de mechas:

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

Resultado: el pedido queda con 1 taladro + 1 mechas, el total se recalcula, y la web descuenta del stock
**1 taladro y 1 mechas**.

### Ejemplo: sólo cambiar el estado

```json
{ "estado": "entregado" }
```

### Ejemplo: la venta no se hizo

```json
{ "estado": "cancelado", "motivo": "El cliente no respondió" }
```

### Reglas

- **`productos`** es la **lista completa** de lo vendido: reemplaza a la anterior.
  - Se pueden **quitar** productos (no ponerlos en la lista), **cambiar cantidades** y **agregar** productos.
  - Los productos nuevos van con el **precio actual** de la web; los que ya estaban mantienen su precio.
  - El total se recalcula solo; el costo de delivery no cambia.
  - Si un producto aparece dos veces, se suman las cantidades.
- **`estado`**: `pendiente`, `confirmado`, `entregado`, `cancelado` o `rechazado`.
- **`motivo`**: opcional. Queda en el historial (y en "rechazado", como motivo del rechazo).
- **Todo o nada:** si algo falla (por ejemplo, no hay stock suficiente para confirmar), **no se aplica ningún
  cambio**: ni los productos ni el estado.

> **Recomendación:** mandar los productos y el estado **en la misma llamada**, como en el primer ejemplo.
> Así el stock se descuenta con los productos correctos.

Respuesta:

```json
{ "ok": true, "productos_modificados": true, "cambio_estado": true, "stock": "descontado", "pedido": { ... } }
```

`stock` dice qué hizo la web con el stock: `descontado`, `devuelto`, `ajustado` (corrigió la diferencia)
o `sin_cambios`.

---

## 3. Ver stock

**Para qué:** saber cuántas unidades hay de cada producto.

```
GET /productos              (todos los productos)
GET /productos?visibles=1   (sólo los que se ven en la tienda)
GET /productos/36           (un producto)
```

```json
{ "id": 36, "nombre": "TALADRO PERCUTOR MAKITA - 13MM", "categoria": "Herramientas eléctricas", "precio": 450000, "stock": 4, "visible": true }
```

El número del producto (`id`) es el mismo que aparece en su página:
`https://todoherramientas.solvis.com.py/producto/36`

---

## 4. Modificar stock (opcional)

**Para qué:** corregir el stock por cosas que **no son ventas de pedidos de la web**: un inventario,
mercadería nueva que llegó, productos rotos o perdidos, ventas hechas en el local, etc.

> **No usar esto para las ventas de los pedidos de la web**: esas las descuenta la web sola al confirmar
> el pedido. Si se usaran las dos cosas para la misma venta, el stock se descontaría dos veces.

Todos estos cambios quedan registrados en el historial de movimientos, con el motivo.

### Fijar el stock en un número

Ejemplo: se hizo inventario y hay 10 taladros.

```
PUT /productos/36/stock
{ "stock": 10, "motivo": "Inventario de noviembre" }
```

### Sumar o restar unidades

Ejemplo: llegaron 5 unidades (sumar) o se rompieron 2 (restar, con número negativo).

```
POST /productos/36/stock/ajuste
{ "cantidad": 5, "motivo": "Llegó mercadería" }
```

```
POST /productos/36/stock/ajuste
{ "cantidad": -2, "motivo": "Rotura" }
```

- El stock **nunca puede quedar negativo**: si se intenta restar más de lo que hay, da error y no cambia nada.
- La respuesta trae el producto con su stock nuevo:

```json
{ "ok": true, "producto": { "id": 36, "nombre": "TALADRO PERCUTOR MAKITA - 13MM", "stock": 8, ... } }
```

---

## 5. Ver movimientos de stock

**Para qué:** ver cada cambio de stock que hubo, con fecha, cantidad, motivo y origen. Sirve para controlar
y para encontrar diferencias.

```
GET /stock/movimientos                     (los últimos 100 de todos los productos)
GET /stock/movimientos?producto=36&limite=50
```

```json
[
  { "id": 120, "fecha": "2026-11-24 10:20:00", "producto_id": 36, "producto": "TALADRO PERCUTOR MAKITA - 13MM",
    "cambio": -1, "stock_resultante": 3, "origen": "api", "pedido_id": 25, "motivo": "Pedido #25 → confirmado", "por": "API" }
]
```

| Dato | Significado |
|---|---|
| `cambio` | Cuánto cambió: negativo = salió, positivo = entró |
| `stock_resultante` | Cuánto quedó después del cambio |
| `origen` | `api` (por la API), `panel` (desde el panel) |
| `pedido_id` | El pedido que lo causó, si fue por un pedido |

---

## Errores

Cuando algo sale mal, la respuesta trae un código y un mensaje en español: `{ "error": "..." }`

| Código | Qué significa | Qué hacer |
|---|---|---|
| **400** | Faltan datos o no son válidos (estado, producto, cantidad) | Revisar lo que se mandó; el mensaje dice qué está mal |
| **401** | La clave falta o es incorrecta | Revisar la clave; si se perdió, generar otra en el panel |
| **404** | El pedido o el producto no existe | Revisar el número |
| **409** | No hay stock suficiente | **No se aplicó ningún cambio.** Revisar el stock o el pedido |
| **429** | Más de 120 llamadas en un minuto | Esperar un minuto |
| **503** | La API está desactivada | Generar una clave en el panel |

---

## Preguntas frecuentes

**¿Qué pasa si confirmo un pedido y no hay stock?**
La API responde con error 409, explica qué producto falta, y el pedido queda como estaba.

**¿Y si dos clientes piden la última unidad?**
Los dos pedidos quedan Pendientes (la web no reserva stock mientras el pedido está pendiente).
El primero que se confirme se lleva la unidad; el segundo da error al confirmar.

**¿Puedo cambiar un pedido que ya está entregado?**
Sí. Si se cambian los productos, la web corrige la diferencia de stock. Si se cancela, devuelve el stock.

**¿Los cambios que hago desde el panel siguen las mismas reglas?**
Sí, exactamente las mismas.

**¿Dónde veo lo que el cliente pidió originalmente?**
En el pedido (`productos_originales`) y en el panel, dentro de cada pedido: "Pedido original del cliente".

---

## Ejemplo completo con curl

```bash
curl -X PATCH https://todoherramientas.solvis.com.py/api/v1/pedidos/25 \
  -H "Authorization: Bearer th_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"productos":[{"producto_id":36,"cantidad":1}],"estado":"confirmado","motivo":"Venta cerrada por WhatsApp"}'
```
