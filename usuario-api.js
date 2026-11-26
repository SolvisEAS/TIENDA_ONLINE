// Crea el usuario de la API, o le pone una contraseña nueva si ya existe.
// Ese usuario sólo sirve para la API (no puede entrar al panel).
//
// Uso:
//   npm run usuario-api -- <usuario>              -> genera una contraseña al azar y la muestra
//   npm run usuario-api -- <usuario> <contraseña> -> usa la contraseña que elijas
//
// Al cambiar la contraseña, los tokens que ya se habían entregado dejan de funcionar.
const crypto = require('crypto');
const { db, hashPassword, validateNewUser, createUser } = require('./db');

const [username, given] = process.argv.slice(2);
if (!username) {
  const users = db.prepare("SELECT username FROM users WHERE role = 'api' ORDER BY username").all();
  console.log('Usuarios de la API:', users.length ? users.map((u) => u.username).join(', ') : '(ninguno todavía)');
  console.log('\nUso: npm run usuario-api -- <usuario> [contraseña]');
  process.exit(0);
}

function randomPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const part = (n) => Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
  return `Api-${part(5)}-${part(5)}`;
}

const password = given || randomPassword();
const error = validateNewUser(username, password);
if (error) {
  console.error(error);
  process.exit(1);
}

const user = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
if (user && user.role !== 'api') {
  console.error(`"${username}" es un usuario del panel. Elegí otro nombre para el usuario de la API (ej: integracion).`);
  process.exit(1);
}
if (user) {
  db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(hashPassword(password), user.id);
  db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(user.id);
  console.log(`\nListo: se cambió la contraseña del usuario de la API "${username}". Los tokens anteriores dejaron de funcionar.`);
} else {
  createUser(username, password, 'api');
  console.log(`\nListo: se creó el usuario de la API "${username}".`);
}
console.log(`\n  Usuario:    ${username}\n  Contraseña: ${password}\n\nPasale estos datos al cliente para que inicie sesión en POST /api/v1/login.`);
