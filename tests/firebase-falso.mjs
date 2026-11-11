// Firebase mínimo en memoria (Firestore + Authentication) para probar la capa de datos sin red.
// No aplica las reglas de seguridad: eso se comprueba en la consola de Firebase (ver README).
export function crearFirebase() {
  const docs = new Map(); // "coleccion/id" -> datos
  const oyentes = new Set();
  const cuentas = new Map(); // email -> contraseña
  const log = [];
  const DELETE = { __delete: true };

  const notificar = () => oyentes.forEach(f => f());

  const filtrar = (col, wh) =>
    [...docs.entries()]
      .filter(([k]) => k.startsWith(col + "/") && !k.slice(col.length + 1).includes("/"))
      .filter(([, v]) => wh.every(([f, op, val]) => (op === "in" ? val.includes(v[f]) : v[f] === val)))
      .map(([k, v]) => ({ id: k.slice(col.length + 1), data: () => structuredClone(v), ref: docRef(k) }));

  const docRef = path => ({
    async get() {
      log.push(["get", path]);
      return { exists: docs.has(path), id: path.split("/").pop(), data: () => structuredClone(docs.get(path)) };
    },
    async set(d) {
      log.push(["set", path]);
      docs.set(path, structuredClone(d));
      notificar();
    },
    async update(d) {
      log.push(["update", path]);
      if (!docs.has(path)) throw { code: "not-found" };
      const cur = { ...docs.get(path) };
      for (const [k, v] of Object.entries(d)) {
        if (v === DELETE) delete cur[k];
        else cur[k] = structuredClone(v);
      }
      docs.set(path, cur);
      notificar();
    },
    async delete() {
      log.push(["delete", path]);
      docs.delete(path);
      notificar();
    }
  });

  const consulta = (col, wh = []) => ({
    where: (f, op, v) => consulta(col, [...wh, [f, op, v]]),
    async get() {
      const r = filtrar(col, wh);
      log.push(["query", col, r.length]);
      return { docs: r, size: r.length };
    },
    onSnapshot(cb) {
      let previo = new Map();
      const emitir = () => {
        const r = filtrar(col, wh);
        const actual = new Map(r.map(x => [x.id, JSON.stringify(x.data())]));
        const cambios = [];
        r.forEach(x => {
          if (!previo.has(x.id)) cambios.push({ type: "added", doc: x });
          else if (previo.get(x.id) !== actual.get(x.id)) cambios.push({ type: "modified", doc: x });
        });
        previo.forEach((_, id) => {
          if (!actual.has(id)) cambios.push({ type: "removed", doc: { id, data: () => ({}) } });
        });
        previo = actual;
        log.push(["snapshot", col, cambios.length]);
        cb({ docs: r, docChanges: () => cambios });
      };
      oyentes.add(emitir);
      emitir();
      return () => oyentes.delete(emitir);
    }
  });

  let actual = null;
  const escuchas = new Set();
  const poner = u => {
    actual = u;
    escuchas.forEach(f => f(u));
  };

  const auth = {
    get currentUser() {
      return actual;
    },
    onAuthStateChanged(cb) {
      escuchas.add(cb);
      setTimeout(() => cb(actual), 0);
      return () => escuchas.delete(cb);
    },
    async createUserWithEmailAndPassword(email, pw) {
      log.push(["auth-create", email]);
      if (cuentas.has(email)) throw { code: "auth/email-already-in-use" };
      cuentas.set(email, pw);
      const u = {
        email,
        uid: "uid-" + email,
        async delete() {
          cuentas.delete(email);
          poner(null);
        },
        async updatePassword(n) {
          cuentas.set(email, n);
        },
        async reauthenticateWithCredential(c) {
          if (cuentas.get(c.email) !== c.pw) throw { code: "auth/invalid-credential" };
        }
      };
      poner(u);
      return { user: u };
    },
    async signInWithEmailAndPassword(email, pw) {
      log.push(["auth-signin", email]);
      if (!cuentas.has(email) || cuentas.get(email) !== pw) throw { code: "auth/invalid-credential" };
      const u = {
        email,
        uid: "uid-" + email,
        async delete() {
          cuentas.delete(email);
          poner(null);
        },
        async updatePassword(n) {
          cuentas.set(email, n);
        },
        async reauthenticateWithCredential(c) {
          if (cuentas.get(c.email) !== c.pw) throw { code: "auth/invalid-credential" };
        }
      };
      poner(u);
      return { user: u };
    },
    async signOut() {
      poner(null);
    }
  };

  const firebase = {
    apps: [],
    initializeApp() {
      firebase.apps.push({});
    },
    firestore: Object.assign(() => ({ doc: docRef, collection: n => consulta(n) }), {
      FieldValue: { delete: () => DELETE }
    }),
    auth: Object.assign(() => auth, { EmailAuthProvider: { credential: (email, pw) => ({ email, pw }) } })
  };

  return { firebase, docs, cuentas, log, auth, notificar };
}
