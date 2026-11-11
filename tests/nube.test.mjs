import test from "node:test";
import assert from "node:assert/strict";
import { cargarApp } from "./entorno.mjs";
import { crearFirebase } from "./firebase-falso.mjs";

const esperar = ms => new Promise(r => setTimeout(r, ms));

async function app(extra = {}) {
  const fb = crearFirebase();
  const w = await cargarApp({ firebase: fb.firebase });
  return { w, fb, ...extra };
}

const ir = async (w, nombre, pw, registrar = false) => {
  if (registrar) w.document.querySelector('[data-m="register"]').click();
  w.document.querySelector("#u").value = nombre;
  w.document.querySelector("#pw").value = pw;
  w.document.querySelector("#go").click();
  await esperar(500);
};

test("la nube usa Firebase Authentication", async () => {
  const { w } = await app();

  assert.equal(w.run("useAuth()"), true);
  assert.match(w.document.querySelector("#app").textContent, /Iniciar sesión/);
});

test("registro: crea la cuenta de acceso y el perfil SIN guardar contraseña en Firestore", async () => {
  const { w, fb } = await app();

  await ir(w, "Marta", "secreto1", true);

  assert.equal(w.run("S.session && S.session.username"), "Marta");
  assert.ok(fb.cuentas.has("marta@users.100cims.invalid"));
  const perfil = fb.docs.get("users/marta");
  assert.equal(perfil.username, "Marta");
  assert.equal("hash" in perfil, false);
});

test("login con la contraseña correcta entra; con una incorrecta no", async () => {
  const { w } = await app();

  await ir(w, "Marta", "secreto1", true);
  w.run("logout()");
  await ir(w, "Marta", "otra-cosa");
  assert.equal(w.run("S.session"), null);
  assert.match(w.document.querySelector("#err").textContent, /incorrectos/);

  await ir(w, "marta", "secreto1");
  assert.equal(w.run("S.session && S.session.username"), "Marta");
});

test("no se puede entrar solo escribiendo un nombre en localStorage (antiguo fallo)", async () => {
  const fb = crearFirebase();
  fb.docs.set("users/pepe", { username: "Pepe", companions: [] });
  const w = await cargarApp({ firebase: fb.firebase, storage: { "cims-session": "Pepe" } });

  assert.equal(w.run("S.session"), null);
  assert.equal(w.localStorage.getItem("cims-session"), null);
});

test("la sesión de Firebase se recupera al volver a abrir la app", async () => {
  const fb = crearFirebase();
  fb.docs.set("users/pepe", { username: "Pepe", companions: [] });
  fb.cuentas.set("pepe@users.100cims.invalid", "x");
  await fb.auth.signInWithEmailAndPassword("pepe@users.100cims.invalid", "x");
  const w = await cargarApp({ firebase: fb.firebase });

  assert.equal(w.run("S.session && S.session.username"), "Pepe");
});

test("migración: una cuenta antigua con hash entra con su contraseña de siempre y pierde el hash", async () => {
  const fb = crearFirebase();
  const w0 = await cargarApp({ firebase: fb.firebase });
  const hash = await w0.run('hashNew("clave-vieja")');
  fb.docs.set("users/lola", { username: "Lola", hash, companions: [], count: 0 });
  const w = await cargarApp({ firebase: fb.firebase });

  await ir(w, "Lola", "mala");
  assert.equal(w.run("S.session"), null);
  assert.ok(fb.docs.get("users/lola").hash, "una contraseña incorrecta no migra nada");

  await ir(w, "Lola", "clave-vieja");
  assert.equal(w.run("S.session && S.session.username"), "Lola");
  assert.equal("hash" in fb.docs.get("users/lola"), false);
  assert.ok(fb.cuentas.has("lola@users.100cims.invalid"));
});

test("nadie puede registrarse con el nombre de una cuenta antigua o del admin", async () => {
  const fb = crearFirebase();
  fb.docs.set("users/lola", { username: "Lola", hash: "x", companions: [] });
  const w = await cargarApp({ firebase: fb.firebase });

  await ir(w, "Lola", "intruso1", true);
  assert.match(w.document.querySelector("#err").textContent, /ya existe/);
  await ir(w, "admin_07", "intruso1");
  assert.equal(w.run("S.session"), null);
});

test("administrador: solo si el servidor lo marca en admins/<uid>", async () => {
  const fb = crearFirebase();
  fb.cuentas.set("admin_07@users.100cims.invalid", "claveadmin");
  const w = await cargarApp({ firebase: fb.firebase });

  await ir(w, "admin_07", "claveadmin");
  assert.equal(w.run("S.session"), null, "sin documento admins/<uid> no es admin");
  assert.match(w.document.querySelector("#err").textContent, /permisos de administrador/);

  fb.docs.set("admins/uid-admin_07@users.100cims.invalid", { enabled: true });
  await ir(w, "admin_07", "claveadmin");
  assert.equal(w.run("S.session && S.session.role"), "admin");
});

test("fotos: se guardan en recphotos y el registro queda ligero; al cargar se recomponen", async () => {
  const { w, fb } = await app();
  const img = "data:image/jpeg;base64,QUJD";

  await ir(w, "Marta", "secreto1", true);
  await w.run(
    `ST.saveRec("Marta", 1, { date: "2026-05-01", notes: "n", comp: [], photo: "${img}", photos: ["${img}", "${img}"], dates: [] }, 1)`
  );

  const reg = fb.docs.get("records/marta__1");
  assert.deepEqual(reg.photos, []);
  assert.equal(reg.photo, "");
  assert.equal(reg.owner, "marta");
  assert.equal(fb.docs.get("recphotos/marta__1").photos.length, 2);

  const d = await w.run('ST.load("Marta")');
  assert.equal(d.done[1].photos.length, 2);
});

test("migración de fotos antiguas: pasan a recphotos y el registro se aligera", async () => {
  const fb = crearFirebase();
  const img = "data:image/jpeg;base64,QUJD";
  fb.docs.set("users/ana", { username: "Ana", companions: [] });
  fb.docs.set("records/ana__7", {
    user: "ana",
    username: "Ana",
    peakId: 7,
    date: "2026-02-02",
    notes: "",
    comp: [],
    photo: img,
    photos: [img]
  });
  fb.cuentas.set("ana@users.100cims.invalid", "pw1234");
  const w = await cargarApp({ firebase: fb.firebase });

  await ir(w, "Ana", "pw1234");
  assert.equal(w.run("S.done[7].photos.length"), 1);
  await w.run('ST.migratePhotos("Ana", ["ana__7"])');

  assert.equal(fb.docs.get("recphotos/ana__7").photos.length, 1);
  assert.deepEqual(fb.docs.get("records/ana__7").photos, []);
  assert.equal(w.run("S.done[7].photos.length"), 1, "la foto sigue visible para su dueña");
});

test("amigos: los registros llegan por listener y cuentan como actividad y cimas por confirmar", async () => {
  const { w, fb } = await app();

  await ir(w, "Marta", "secreto1", true);
  fb.docs.set("friendreqs/marta__luis", { from: "Marta", to: "Luis", fromK: "marta", toK: "luis", accepted: true });
  fb.docs.set("records/luis__3", {
    user: "luis",
    username: "Luis",
    peakId: 3,
    date: "2026-04-04",
    comp: ["Marta"],
    notes: ""
  });
  fb.docs.set("records/luis__4", {
    user: "intruso",
    username: "Intruso",
    peakId: 4,
    date: "2026-04-05",
    comp: ["Marta"],
    notes: ""
  }); // id no coincide: falso
  fb.notificar();
  await esperar(200);
  fb.notificar(); // las amistades llegan primero; después se suscribe a los registros de los amigos
  await esperar(200);

  const feed = w.run("S.feed");
  assert.equal(feed.length, 1);
  assert.equal(feed[0].peakId, 3);
  const pend = w.run("S.shares");
  assert.equal(pend.length, 1);
  assert.equal(pend[0].from, "Luis");
});

test("amigos: no se vuelve a consultar entera la base de datos cada 45 s (sin sondeo)", async () => {
  const { w, fb } = await app();

  await ir(w, "Marta", "secreto1", true);
  fb.docs.set("friendreqs/marta__luis", { from: "Marta", to: "Luis", fromK: "marta", toK: "luis", accepted: true });
  fb.notificar();
  await esperar(300);
  const antes = fb.log.filter(x => x[0] === "query").length;
  await w.run("ST.discover()");
  await w.run("ST.discover()");
  assert.equal(fb.log.filter(x => x[0] === "query").length, antes, "discover() usa la caché de los listeners");
});

test("borrar la cuenta elimina datos y acceso", async () => {
  const { w, fb } = await app();

  await ir(w, "Marta", "secreto1", true);
  await w.run(
    'ST.saveRec("Marta", 1, { date: "2026-05-01", notes: "", comp: [], photo: "", photos: [], dates: [] }, 1)'
  );
  w.run("openDelAcc()");
  w.document.querySelector("#dpw").value = "secreto1";
  w.document.querySelector("#dpg").click();
  await esperar(500);

  assert.equal(fb.docs.has("users/marta"), false);
  assert.equal(fb.docs.has("records/marta__1"), false);
  assert.equal(fb.cuentas.has("marta@users.100cims.invalid"), false);
  assert.equal(w.run("S.session"), null);
});

test("cambiar la contraseña exige la actual", async () => {
  const { w, fb } = await app();

  await ir(w, "Marta", "secreto1", true);
  w.run("openChPw()");
  w.document.querySelector("#cp0").value = "mal";
  w.document.querySelector("#cp1").value = "nueva123";
  w.document.querySelector("#cp2").value = "nueva123";
  w.document.querySelector("#cpg").click();
  await esperar(300);
  assert.equal(fb.cuentas.get("marta@users.100cims.invalid"), "secreto1");

  w.document.querySelector("#cp0").value = "secreto1";
  w.document.querySelector("#cpg").click();
  await esperar(300);
  assert.equal(fb.cuentas.get("marta@users.100cims.invalid"), "nueva123");
});
