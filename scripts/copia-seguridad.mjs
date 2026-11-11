// Copia de seguridad de Firestore a un archivo JSON (todas las colecciones de la app).
//
// Uso (una vez por semana/mes, o antes de cambiar reglas o datos):
//   1. npm install --no-save firebase-admin
//   2. Firebase consola → Configuración del proyecto → Cuentas de servicio → "Generar nueva clave privada".
//      Guarda el archivo como  scripts/clave-servicio.json  (¡NO lo subas a GitHub! está en .gitignore).
//   3. node scripts/copia-seguridad.mjs
// Crea  copias/copia-AAAA-MM-DD.json . Para restaurar:  node scripts/copia-seguridad.mjs --restaurar copias/copia-....json
//
// Nota: las contraseñas viven en Firebase Authentication y no se exportan aquí; para eso ver README.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const clave = path.join(import.meta.dirname, "clave-servicio.json");

if (!fs.existsSync(clave)) {
  console.error("Falta scripts/clave-servicio.json (ver las instrucciones al principio de este archivo).");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(clave, "utf8"))) });

const db = admin.firestore();
const COLECCIONES = ["users", "records", "recphotos", "friendreqs", "peakreqs", "peaks", "peaksov", "admins"];
const i = process.argv.indexOf("--restaurar");

if (i > -1) {
  const archivo = process.argv[i + 1];
  const copia = JSON.parse(fs.readFileSync(archivo, "utf8"));
  let n = 0;

  for (const [col, docs] of Object.entries(copia.colecciones)) {
    for (const [id, data] of Object.entries(docs)) {
      await db.collection(col).doc(id).set(data);
      n++;
    }
  }

  console.log(`Restaurados ${n} documentos desde ${archivo}`);
} else {
  const salida = { fecha: new Date().toISOString(), colecciones: {} };
  let n = 0;

  for (const col of COLECCIONES) {
    const s = await db.collection(col).get();

    salida.colecciones[col] = {};
    s.forEach(d => {
      salida.colecciones[col][d.id] = d.data();
      n++;
    });
  }

  fs.mkdirSync("copias", { recursive: true });

  const nombre = path.join("copias", `copia-${new Date().toISOString().slice(0, 10)}.json`);

  fs.writeFileSync(nombre, JSON.stringify(salida));
  console.log(`Copia guardada en ${nombre} (${n} documentos)`);
}
