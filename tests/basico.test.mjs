import test from "node:test";
import assert from "node:assert/strict";
import { cargarApp } from "./entorno.mjs";

test("sid: claves de usuario estables y sin caracteres problemáticos", async () => {
  const w = await cargarApp();

  assert.equal(w.run("sid('Pepe')"), "pepe");
  assert.equal(w.run("sid('Mont_Serrat.99')"), "mont_serrat.99");
  assert.match(w.run("sid('José')"), /^jos~C3~A9$/);
  assert.equal(w.run("authEmail('Pepe')"), "pepe@users.100cims.invalid");
  assert.equal(w.run("authEmail('admin_07')"), "admin_07@users.100cims.invalid");
  // Firebase guarda el correo en minúsculas: las reglas comparan con id.lower(), así que authEmail ya sale en minúsculas.
  assert.equal(w.run("authEmail('José')"), "jos~c3~a9@users.100cims.invalid");
});

test("las claves de usuario distintas nunca colisionan", async () => {
  const w = await cargarApp();
  const nombres = ["ana", "Ana", "ANA", "a.na", "a_na", "a-na", "José", "Jose", "jos~c3~a9"];
  const claves = nombres.map(n => w.run(`sid(${JSON.stringify(n)})`));

  // "ana", "Ana" y "ANA" son la misma persona; el resto debe ser distinto.
  assert.equal(new Set(claves).size, nombres.length - 2);
});

test("okRec descarta registros cuyo id no coincide con su dueño", async () => {
  const w = await cargarApp();
  const doc = (id, user) => ({ id, data: () => ({ user }) });

  assert.equal(w.run("okRec")(doc("pepe__5", "pepe")), true);
  assert.equal(w.run("okRec")(doc("pepe__5", "ana")), false); // intento de colar un registro en la lista de otra persona
  assert.equal(w.run("okRec")(doc("a__b__5", "a__b")), true);
});

test("toDone: usa las fotos de recphotos y respeta las antiguas", async () => {
  const w = await cargarApp();
  const img = "data:image/jpeg;base64,AAAA";
  const snap = {
    docs: [
      { id: "pepe__1", data: () => ({ user: "pepe", peakId: 1, date: "2026-01-01", photos: [] }) },
      { id: "pepe__2", data: () => ({ user: "pepe", peakId: 2, date: "2026-01-02", photo: img }) },
      { id: "ana__3", data: () => ({ user: "pepe", peakId: 3, date: "2026-01-03" }) } // falso
    ]
  };
  const d = w.run("toDone")(snap, { pepe__1: [img, img] });

  assert.equal(d[1].photos.length, 2);
  assert.equal(d[2].photo, img);
  assert.equal(d[3], undefined);
});

test("arranca en modo local y muestra la pantalla de acceso", async () => {
  const w = await cargarApp();

  assert.match(w.document.querySelector("#app").textContent, /Iniciar sesión/);
});

test("modo local: registrarse y entrar funciona; el admin no existe sin nube", async () => {
  const w = await cargarApp();

  w.document.querySelector('[data-m="register"]').click();
  w.document.querySelector("#u").value = "Marta";
  w.document.querySelector("#pw").value = "secreto1";
  w.document.querySelector("#go").click();
  await new Promise(r => setTimeout(r, 400));

  assert.equal(w.run("S.session && S.session.username"), "Marta");

  w.run("logout()");
  w.document.querySelector("#u").value = "admin_07";
  w.document.querySelector("#pw").value = "cualquiera";
  w.document.querySelector("#go").click();
  await new Promise(r => setTimeout(r, 200));

  assert.equal(w.run("S.session"), null);
  assert.match(w.document.querySelector("#err").textContent, /nube/);
});

test("el hash del administrador ya no está en el código", async () => {
  const fs = await import("node:fs");
  const estado = fs.readFileSync(new URL("../js/estado.js", import.meta.url), "utf8");

  assert.equal(/ADMIN_HASH|pbkdf2\$/.test(estado), false);
});
