// Carga la app real (los mismos <script> y en el mismo orden que index.html) dentro de jsdom,
// sin Firebase, para poder probarla sin navegador.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const raiz = path.join(import.meta.dirname, "..");

const esperar = ms => new Promise(r => setTimeout(r, ms));

export async function cargarApp({ firebase = null, storage = {} } = {}) {
  const html = fs.readFileSync(path.join(raiz, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]);

  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: "https://reto.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });

  const w = dom.window;

  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);

  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.crypto.subtle = globalThis.crypto.subtle;
  w.TextEncoder = globalThis.TextEncoder;
  if (firebase) w.firebase = firebase;

  // Se ejecutan como <script> clásicos (las const/let de un archivo son visibles en los siguientes).
  const ctx = dom.getInternalVMContext();

  w.run = code => new vm.Script(code).runInContext(ctx);

  for (const s of scripts) {
    w.run(fs.readFileSync(path.join(raiz, s), "utf8"));
  }

  await esperar(300); // deja terminar boot(), que arranca solo al cargar arranque.js

  return w;
}
