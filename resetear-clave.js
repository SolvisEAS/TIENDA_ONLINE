// Resetea la contraseña de un usuario del panel desde la terminal.
// Sirve cuando el dueño de la tienda pierde el acceso.
//
// Uso:
//   npm run resetear-clave                          -> muestra los usuarios
//   npm run resetear-clave -- <usuario>             -> genera una contraseña nueva al azar y la muestra
//   npm run resetear-clave -- <usuario> <contraseña> -> pone la contraseña que vos elijas
//
// Al resetear, se cierran las sesiones abiertas de ese usuario (aunque la tienda esté encendida).
// Si todavía no existe ningún usuario (instalación nueva), crea el primero.
const crypto = require('crypto');
const { db, hashPassword, validateNewUser, createUser } = require('./db');

const [username, given] = process.argv.slice(2);
const users = db.prepare('SELECT username, created_at FROM users ORDER BY username').all();

if (!username) {
  console.log('Usuarios del panel:');
  for (const u of users) console.log(`  - ${u.username}`);
  if (!users.length) console.log('  (ninguno todavía)');
  console.log('\nUso: npm run resetear-clave -- <usuario> [contraseña nueva]');
  process.exit(0);
}

// Contraseña al azar, fácil de dictar: sin letras que se confunden (0/O, 1/l/I)
function randomPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const part = (n) => Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
  return `Todo-${part(4)}-${part(4)}`;
}

const password = given || randomPassword();
const error = validateNewUser(username, password);
if (error) {
  console.error(error);
  process.exit(1);
}

const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (user) {
  db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(hashPassword(password), user.id);
  console.log(`\nListo: se cambió la contraseña de "${user.username}".`);
  console.log('Las sesiones que tenía abiertas se cerraron.');
} else if (!users.length) {
  createUser(username, password);
  console.log(`\nListo: se creó el usuario "${username}" (primer usuario del panel).`);
} else {
  console.error(`No existe el usuario "${username}". Usuarios del panel: ${users.map((u) => u.username).join(', ')}`);
  process.exit(1);
}

if (!given) console.log(`\nContraseña nueva: ${password}\nPasásela a la persona y pedile que la cambie en Configuración → Cambiar mi contraseña.`);
