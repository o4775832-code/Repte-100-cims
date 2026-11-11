// Lista los textos en castellano del código que NO tienen traducción al catalán en la tabla CAS
// (js/almacenamiento.js). Sirve para no olvidar textos nuevos (por ejemplo, los del panel de admin).
//   node scripts/textos-sin-traducir.mjs
import fs from "node:fs";
import path from "node:path";
import * as espree from "espree";

const dir = path.join(import.meta.dirname, "..", "js");
const src = fs.readFileSync(path.join(dir, "almacenamiento.js"), "utf8");
// Las claves de CAS se leen evaluando solo esa tabla (sin ejecutar el resto de la app).
const ini = src.indexOf("const CAS = ["),
  fin = src.indexOf("].sort(", ini) + 1,
  tabla = src.slice(ini, fin).replace("const CAS =", "return");
const keys = new Function(tabla)().map(p => p[0]);

const texts = new Set();

// Cada trozo de texto visible (entre etiquetas HTML y huecos ${...}) se comprueba por separado.
const addText = raw => {
  for (const t of raw.split(/<[^>]*>|\$\{[^}]*\}|[^\s<>]*="[^"]*"[^<>]*>/).map(x => x.replace(/\s+/g, " ").trim()))
    addFragment(t);
};

const addFragment = t => {
  // Solo frases que parecen castellano visible para la persona usuaria.
  if (t.length < 6 || !/[a-záéíóúñ]{3,}/i.test(t) || !/\s/.test(t)) return;
  if (/^[a-z0-9_.#:\-\[\]()\/ ]+$/.test(t) && !/[áéíóúñ¿¡]/i.test(t)) return; // clases CSS, selectores...

  texts.add(t);
};

const esCastellano = x => !/\b(el|la|els|les|amb|per|teva|teus|ets|és|són)\b|[àèòçï·]/i.test(x);

for (const f of fs
  .readdirSync(dir)
  .filter(x => x.endsWith(".js") && !["catalogo.js", "firebase-config.js"].includes(x))) {
  let code = fs.readFileSync(path.join(dir, f), "utf8");

  if (f === "almacenamiento.js")
    code =
      code.slice(0, code.indexOf("const D = {")) +
      code.slice(code.indexOf("].sort(", code.indexOf("const CAS = [")) + 7);

  const toks = espree.tokenize(code, { ecmaVersion: 2022, loc: true });

  for (const t of toks) {
    if (t.type === "String") addText(t.value.slice(1, -1));
    else if (t.type === "Template") addText(t.value.replace(/^[`}]|(\$\{|`)$/g, ""));
  }
}

const missing = [...texts].filter(
  t =>
    esCastellano(t) &&
    /[áéíóúñ¿¡]|\b(el|la|los|las|tu|tus|de|del|para|con|sin|una?|ya|no|se)\b/i.test(t) &&
    !keys.some(k => t.includes(k))
);

console.log(missing.sort().join("\n"));
console.error(`\n${missing.length} textos sin traducir (revisa a mano: puede haber falsos positivos).`);
