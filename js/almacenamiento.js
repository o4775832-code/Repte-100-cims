/* ===== Almacenamiento: nube (db compartida) o local (este navegador) ===== */

let DB = null,
  CLOUD = false;

const lk = u => u.toLowerCase();

const sid = u =>
  encodeURIComponent(lk(u))
    .replace(/%/g, "~")
    .replace(/[!'()*]/g, c => "~" + c.charCodeAt(0).toString(16));

const withTO = (p, ms = 12000) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r({ code: "timeout" }), ms))]);

const errMsg = e => {
  const c = e && e.code;

  return c === "nocrypto"
    ? "Este navegador no puede cifrar contraseñas (usa una conexión https)."
    : c === "timeout" || c === "unavailable" || c === "auth/network-request-failed"
      ? "No se pudo conectar con la nube. Inténtalo de nuevo."
      : c === "invalid_argument"
        ? "Tu acceso a este enlace no permite guardar datos. Pide al propietario acceso de colaborador."
        : c === "quota_exceeded" || c === "resource-exhausted"
          ? "Almacenamiento lleno (¿fotos muy pesadas?). Quita alguna foto."
          : c === "local"
            ? "Este navegador no permite guardar datos."
            : c === "auth/too-many-requests"
              ? "Demasiados intentos. Espera unos minutos y vuelve a probar."
              : c === "auth/email-already-in-use" || c === "exists"
                ? "Ese usuario ya existe."
                : c === "auth/weak-password"
                  ? "La contraseña necesita al menos 6 caracteres."
                  : c === "auth/invalid-email" || c === "auth/missing-email"
                    ? "Ese nombre de usuario no se puede usar. Prueba con otro."
                    : c === "auth/operation-not-allowed" || c === "auth/configuration-not-found"
                      ? "El acceso con usuario y contraseña no está activado en Firebase (ver README)."
                      : c === "bad-credentials" || c === "auth/wrong-password" || c === "auth/invalid-credential"
                        ? "Usuario o contraseña incorrectos."
                        : c === "not-admin"
                          ? "Esta cuenta no tiene permisos de administrador."
                          : c === "permission-denied"
                            ? "No tienes permiso para hacer eso. Si acabas de actualizar la app, publica las reglas de Firestore (ver README)."
                            : "No se pudo guardar. Inténtalo de nuevo.";
};

/* Utilidades de la capa de datos en la nube */

const recKey = (u, id) => sid(u) + "__" + id;

// Un registro solo es válido si su id empieza por la clave del usuario que dice ser su dueño.
// Con las reglas nuevas solo el dueño puede crear ese id; esto descarta además cualquier dato antiguo o manipulado.
const okRec = d => {
  const r = d.data();

  return !!r && typeof r.user === "string" && d.id.startsWith(sid(r.user) + "__");
};

const chunk = (a, n) => {
  const o = [];

  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));

  return o;
};

const hasInlinePhotos = r =>
  (Array.isArray(r.photos) && r.photos.length > 0) || (typeof r.photo === "string" && r.photo !== "");

const fieldDelete = () => firebase.firestore.FieldValue.delete();

/* photos: { idDelRegistro: [fotos] } (colección recphotos). Los registros antiguos aún pueden traer las fotos dentro. */
const toDone = (snap, photos = {}) => {
  const d = {};

  snap.docs.forEach(x => {
    const r = x.data();

    if (!okRec(x)) return;
    if (!Number.isInteger(+r.peakId)) return;

    const sep = photos[x.id],
      src = Array.isArray(sep) && sep.length ? sep : Array.isArray(r.photos) ? r.photos : r.photo ? [r.photo] : [],
      ph = src.filter(isImg).slice(0, 4);

    d[+r.peakId] = {
      date: String(r.date || ""),
      notes: String(r.notes || ""),
      comp: (Array.isArray(r.comp) ? r.comp : []).map(String),
      photo: ph[0] || "",
      photos: ph,
      dates: (Array.isArray(r.dates) ? r.dates : []).map(String)
    };
  });

  return d;
};

/* Seguimiento en tiempo real de los registros de los amigos (sustituye al sondeo cada 45 s).
   Un listener (onSnapshot) por cada 10 amigos: tras la carga inicial solo llegan los cambios. */
const FW = { cache: new Map(), subs: [], sig: null, cb: null, ready: false };

const computeShares = () => {
  const me_ = S.session.username,
    m = lk(me_),
    out = [],
    feed = [];

  FW.cache.forEach((r, id) => {
    if (!r || typeof r.user !== "string" || !id.startsWith(sid(r.user) + "__")) return;
    if (!Number.isInteger(+r.peakId)) return;

    const peakId = +r.peakId,
      f = lk(r.user),
      fn = r.username || r.user,
      comp = Array.isArray(r.comp) ? r.comp : [];

    feed.push({ u: fn, peakId, date: r.date || "", n: comp.length });

    if (!comp.some(c => lk(c) === m)) return;
    if (S.done[peakId] || (S.declined || []).includes(f + "|" + peakId)) return;

    out.push({
      from: fn,
      to: me_,
      fromK: f,
      toK: m,
      peakId,
      date: r.date || "",
      comp: [fn, ...comp.filter(c => lk(c) !== m && lk(c) !== f)]
    });
  });

  S.feed = feed;

  return out;
};

const fwStop = () => {
  FW.subs.forEach(u => u());
  FW.subs = [];
  FW.cache.clear();
  FW.sig = null;
  FW.ready = false;
};

// Se llama al arrancar y cada vez que cambia la lista de amigos: solo vuelve a suscribirse si de verdad cambió.
const fwSync = () => {
  if (!CLOUD || !FW.cb || !S.session || S.session.role !== "user") return;

  const keys = [...new Set(friends().map(lk))].sort(),
    sig = keys.join("|");

  if (sig === FW.sig) return;

  const had = FW.subs.length > 0;

  fwStop();
  FW.sig = sig;

  const emit = () => {
    FW.ready = true;

    if (FW.cb) FW.cb(computeShares());
  };

  if (!keys.length) {
    // Sin amigos no hay nada que vigilar. Solo se avisa si antes los había (para vaciar lo que se mostraba).
    if (had) emit();
    else FW.ready = true;

    return;
  }

  chunk(keys, 10).forEach(part =>
    FW.subs.push(
      DB.collection("records")
        .where("user", "in", part)
        .onSnapshot(
          snap => {
            snap.docChanges().forEach(ch => {
              if (ch.type === "removed") FW.cache.delete(ch.doc.id);
              else FW.cache.set(ch.doc.id, ch.doc.data());
            });

            emit();
          },
          () => {}
        )
    )
  );
};

const ST = {
  syncFriends: () => fwSync(),

  async getUser(u) {
    if (CLOUD) {
      try {
        const x = await withTO(DB.doc("users/" + sid(u)).get());

        return x.exists ? x.data() : null;
      } catch (e) {
        // Sin sesión, las reglas solo dejan leer cuentas antiguas pendientes de migrar: el resto cuenta como "no existe".
        if (e && e.code === "permission-denied" && !(AUTH && AUTH.currentUser)) return null;

        throw e;
      }
    }

    return S.users.find(v => lk(v.username) === lk(u)) || null;
  },

  async createUser(x) {
    if (CLOUD) {
      await withTO(DB.doc("users/" + sid(x.username)).set({ ...x, companions: [], count: 0 }));
      return;
    }

    S.users.push(x);
    S.data[x.username] = { done: {}, companions: [] };

    if (!saveLocal()) throw { code: "local" };
  },

  async load(u) {
    if (CLOUD) {
      const [us, rs, ph] = await Promise.all([
        withTO(DB.doc("users/" + sid(u)).get()),
        withTO(DB.collection("records").where("user", "==", lk(u)).get()),
        ST.fetchPhotos(u)
      ]);

      return {
        done: toDone(rs, ph),
        companions: (us.exists && us.data().companions) || [],
        declined: (us.exists && us.data().declined) || [],
        avatar: (us.exists && us.data().avatar) || "",
        wish: (us.exists && us.data().wish) || [],
        // registros antiguos que aún llevan las fotos dentro del documento (se pasan a recphotos en segundo plano)
        legacyPhotos: rs.docs.filter(d => okRec(d) && hasInlinePhotos(d.data())).map(d => d.id)
      };
    }

    const d = S.data[u] || { done: {}, companions: [] };

    return {
      done: d.done || {},
      companions: d.companions || [],
      avatar: (S.users.find(v => lk(v.username) === lk(u)) || {}).avatar || "",
      wish: d.wish || []
    };
  },

  // Fotos de un usuario (colección recphotos): { idDelRegistro: [fotos] }
  async fetchPhotos(u) {
    if (!CLOUD) return {};

    try {
      const s = await withTO(DB.collection("recphotos").where("owner", "==", sid(u)).get(), 30000),
        m = {};

      s.docs.forEach(d => {
        m[d.id] = (d.data() || {}).photos || [];
      });

      return m;
    } catch (e) {
      return {};
    }
  },

  // Pasa a recphotos las fotos que los registros antiguos guardaban dentro del propio documento.
  // Es idempotente y silenciosa: si falla algo, el registro conserva sus fotos y se reintenta en el próximo acceso.
  async migratePhotos(u, ids) {
    if (!CLOUD || !ids || !ids.length) return;

    for (const id of ids) {
      try {
        const pid = +id.split("__").pop(),
          d = S.done[pid];

        if (!d || !d.photos || !d.photos.length) continue;

        await withTO(DB.doc("recphotos/" + id).set({ owner: sid(u), photos: d.photos }), 30000);
        await withTO(DB.doc("records/" + id).update({ photo: "", photos: [] }));
      } catch (e) {
        return;
      }
    }
  },

  async saveRec(u, id, rec, count) {
    if (CLOUD) {
      const key = recKey(u, id),
        ref = DB.doc("records/" + key),
        pref = DB.doc("recphotos/" + key);

      if (rec) {
        const photos = (rec.photos && rec.photos.length ? rec.photos : rec.photo ? [rec.photo] : [])
          .filter(isImg)
          .slice(0, 4);

        // Las fotos van en su propio documento para que leer los registros (los tuyos y los de tus amigos) sea ligero.
        if (photos.length) await withTO(pref.set({ owner: sid(u), photos }), 30000);
        else await withTO(pref.delete());

        await withTO(
          ref.set({
            user: lk(u),
            username: u,
            owner: sid(u),
            peakId: +id,
            date: rec.date,
            notes: rec.notes,
            comp: rec.comp,
            photo: "",
            photos: [],
            dates: rec.dates || []
          })
        );
      } else {
        await withTO(ref.delete());
        await withTO(pref.delete());
      }

      // El contador (informativo) se calcula con lo que ya tenemos en memoria: antes se releían todos tus registros en cada guardado.
      await withTO(DB.doc("users/" + sid(u)).update({ count: nDone(), last: rec ? rec.date : "" }));

      return;
    }

    if (!saveLocal()) throw { code: "local" };
  },

  async delRec(u, id) {
    if (CLOUD) {
      await withTO(DB.doc("records/" + recKey(u, id)).delete());
      await withTO(DB.doc("recphotos/" + recKey(u, id)).delete());

      // Solo el administrador borra registros de otra persona: ahí hay que recalcular su contador leyendo sus registros.
      if (S.session && S.session.role === "admin") {
        const rs = await withTO(DB.collection("records").where("user", "==", lk(u)).get());

        await withTO(
          DB.doc("users/" + sid(u)).update({
            count: rs.docs.filter(d => okRec(d) && S.peaks.some(p => p.id === d.data().peakId && isEss(p))).length
          })
        );
      } else {
        await withTO(DB.doc("users/" + sid(u)).update({ count: nDone() }));
      }

      return;
    }

    const d = S.data[u];

    if (d && d.done) delete d.done[id];

    if (!saveLocal()) throw { code: "local" };
  },

  async setRecPhoto(u, id, rec) {
    if (CLOUD) {
      await withTO(DB.doc("records/" + recKey(u, id)).update({ photo: "", photos: [] }));
      await withTO(DB.doc("recphotos/" + recKey(u, id)).delete());
      return;
    }

    const d = S.data[u];

    if (d && d.done && d.done[id]) d.done[id].photo = "";
    if (d && d.done && d.done[id]) d.done[id].photos = [];

    if (!saveLocal()) throw { code: "local" };
  },

  async saveComp(u, list) {
    if (CLOUD) {
      await withTO(DB.doc("users/" + sid(u)).update({ companions: list }));
      return;
    }

    if (!saveLocal()) throw { code: "local" };
  },

  localUsers() {
    return S.users.map(u => ({
      ...u,
      count: Object.keys((S.data[u.username] || { done: {} }).done || {}).filter(k =>
        S.peaks.some(p => p.id === +k && isEss(p))
      ).length
    }));
  },

  watchUsers(cb) {
    if (!CLOUD) {
      cb(ST.localUsers());
      return () => {};
    }

    return DB.collection("users").onSnapshot(
      s =>
        cb(
          s.docs.map(d => {
            const x = { ...d.data() };

            // "legacy": cuenta antigua que aún no ha entrado con el sistema nuevo (conserva el hash viejo).
            x.legacy = !!x.hash;
            delete x.hash;

            return x;
          })
        ),
      () => {}
    );
  },

  async userRecs(u) {
    if (CLOUD) {
      const [rs, ph] = await Promise.all([
        withTO(DB.collection("records").where("user", "==", lk(u)).get()),
        ST.fetchPhotos(u)
      ]);

      return toDone(rs, ph);
    }

    return (S.data[u] || { done: {} }).done || {};
  },

  async delUser(u) {
    if (CLOUD) {
      const k = lk(u),
        sk = sid(u),
        del = async path => withTO(DB.doc(path).delete());

      const rs = await withTO(DB.collection("records").where("user", "==", k).get());

      for (const d of rs.docs) if (d.id.startsWith(sk + "__")) await del("records/" + d.id);

      const ps = await withTO(DB.collection("recphotos").where("owner", "==", sk).get());

      for (const d of ps.docs) await del("recphotos/" + d.id);

      // Solicitudes de amistad donde participa (dos consultas pequeñas en lugar de leer toda la colección).
      for (const campo of ["fromK", "toK"]) {
        const q = await withTO(DB.collection("friendreqs").where(campo, "==", k).get());

        for (const d of q.docs) await del("friendreqs/" + d.id);
      }

      await del("users/" + sk);

      return;
    }

    S.users = S.users.filter(v => lk(v.username) !== lk(u));
    delete S.data[u];
    S.reqs = S.reqs.filter(r => r.fromK !== lk(u) && r.toK !== lk(u));
    S.shares = S.shares.filter(x => x.fromK !== lk(u) && x.toK !== lk(u));

    if (!saveLocal()) throw { code: "local" };
  },

  // El administrador autoriza que alguien recupere su cuenta (ver README: se borra su acceso en Authentication y el usuario
  // vuelve a registrarse con el mismo nombre; la cuenta conserva sus cimas y amistades).
  async allowReclaim(u) {
    if (CLOUD) await withTO(DB.doc("users/" + sid(u)).update({ reclaim: true }));
  },

  async saveWish(u, w) {
    if (CLOUD) {
      await withTO(DB.doc("users/" + sid(u)).update({ wish: w }));
      return;
    }

    if (!saveLocal()) throw { code: "local" };
  },

  async setAvatar(u, v) {
    if (CLOUD) {
      await withTO(DB.doc("users/" + sid(u)).update({ avatar: v }));
      return;
    }

    const x = S.users.find(w => lk(w.username) === lk(u));

    if (x) x.avatar = v;

    if (!saveLocal()) throw { code: "local" };
  },

  async setPassword(u, h) {
    if (CLOUD) {
      await withTO(DB.doc("users/" + sid(u)).update({ hash: h }));
      return;
    }

    const x = S.users.find(v => lk(v.username) === lk(u));

    if (x) x.hash = h;

    if (!saveLocal()) throw { code: "local" };
  },

  async sendShare(names, id, rec, by) {
    const out = [];

    for (const n of names) {
      const comp = [by, ...rec.comp.filter(c => lk(c) !== lk(n) && lk(c) !== lk(by))];
      const s = { from: by, to: n, fromK: lk(by), toK: lk(n), peakId: id, date: rec.date, comp };

      if (CLOUD) {
        if ((await withTO(DB.doc("records/" + sid(n) + "__" + id).get())).exists) continue;

        out.push(n);
      } else {
        const d = S.data[n];

        if (d && d.done && d.done[id]) continue;

        S.shares = S.shares.filter(x => !(x.fromK === s.fromK && x.toK === s.toK && x.peakId === id));
        S.shares.push(s);
        out.push(n);
      }
    }

    if (!CLOUD && !saveLocal()) throw { code: "local" };

    return out;
  },

  async answerShare(s, ok) {
    if (ok && !S.done[s.peakId]) {
      const rec = { date: s.date, notes: "", comp: s.comp, photo: "", photos: [], dates: [] };

      S.done[s.peakId] = rec;

      try {
        await ST.saveRec(S.session.username, s.peakId, rec, Object.keys(S.done).length);
      } catch (e) {
        delete S.done[s.peakId];
        throw e;
      }
    }

    if (CLOUD && !ok) {
      S.declined = [...(S.declined || []), s.fromK + "|" + s.peakId];

      await withTO(DB.doc("users/" + sid(S.session.username)).update({ declined: S.declined }));
    }

    S.shares = S.shares.filter(x => !(x.fromK === s.fromK && x.toK === s.toK && x.peakId === s.peakId));

    if (!CLOUD && !saveLocal()) throw { code: "local" };
  },

  watchShares(cb) {
    if (!CLOUD) {
      cb(S.shares);

      const f = e => {
        if (e.key !== KEY) return;

        try {
          cb(JSON.parse(e.newValue || "{}").shares || []);
        } catch (_) {}
      };

      addEventListener("storage", f);

      return () => removeEventListener("storage", f);
    }

    FW.cb = cb;
    fwSync();

    return () => {
      FW.cb = null;
      fwStop();
    };
  },

  // Ya no consulta la base de datos: usa lo que los listeners de fwSync() mantienen al día.
  async discover() {
    if (!CLOUD || !FW.ready) return S.shares;

    return computeShares();
  },

  async allUsers() {
    if (CLOUD) {
      // Caché de 3 minutos: abrir y cerrar la pestaña Amigos ya no relee todos los usuarios cada vez.
      if (ST._au && Date.now() - ST._au.t < 180000) return ST._au.l;

      const s = await withTO(DB.collection("users").get());

      const l = s.docs.map(d => {
        const x = { ...d.data() };

        delete x.hash;
        delete x.reclaim;

        return x;
      });

      ST._au = { t: Date.now(), l };

      return l;
    }

    return ST.localUsers();
  },

  async sendReq(from, to) {
    const r = { from, to, fromK: lk(from), toK: lk(to), accepted: false, date: new Date().toISOString() };

    if (CLOUD) await withTO(DB.doc("friendreqs/" + sid(from) + "__" + sid(to)).set(r));

    S.reqs.push(r);

    if (!CLOUD && !saveLocal()) {
      S.reqs.pop();
      throw { code: "local" };
    }
  },

  async answerReq(r, ok) {
    if (CLOUD) {
      const ref = DB.doc("friendreqs/" + sid(r.from) + "__" + sid(r.to));

      await withTO(ok ? ref.update({ accepted: true }) : ref.delete());
    }

    const same = x => x.fromK === r.fromK && x.toK === r.toK;

    if (ok)
      S.reqs.forEach(x => {
        if (same(x)) x.accepted = true;
      });
    else S.reqs = S.reqs.filter(x => !same(x));

    if (!CLOUD && !saveLocal()) throw { code: "local" };
  },

  watchReqs(cb) {
    if (!CLOUD) {
      cb(S.reqs);

      const f = e => {
        if (e.key !== KEY) return;

        try {
          cb(JSON.parse(e.newValue || "{}").reqs || []);
        } catch (_) {}
      };

      addEventListener("storage", f);

      return () => removeEventListener("storage", f);
    }

    // El administrador ve todas las solicitudes; cada usuario, solo las enviadas y recibidas por él
    // (antes todos descargaban y vigilaban la colección entera).
    if (S.session && S.session.role === "admin") {
      return DB.collection("friendreqs").onSnapshot(
        s => cb(s.docs.map(d => d.data())),
        () => {}
      );
    }

    const m = lk(S.session.username),
      got = { fromK: null, toK: null };

    const push = () => {
      if (!got.fromK || !got.toK) return; // esperamos a tener las dos mitades para no dar avisos a medias

      const all = new Map([...got.fromK, ...got.toK]);

      cb([...all.values()]);
    };

    const sub = campo =>
      DB.collection("friendreqs")
        .where(campo, "==", m)
        .onSnapshot(
          s => {
            got[campo] = new Map(s.docs.map(d => [d.id, d.data()]));
            push();
          },
          () => {}
        );

    const u1 = sub("fromK"),
      u2 = sub("toK");

    return () => {
      u1();
      u2();
    };
  },

  async sendPeakReq(r) {
    // ownerS: clave del autor; las reglas la exigen para que cada usuario pueda retirar solo sus solicitudes.
    if (CLOUD) await withTO(DB.doc("peakreqs/" + r.id).set({ ...r, ownerS: sid(r.user) }));

    if (!S.pk.some(x => x.id === r.id)) S.pk.push(r);

    if (!CLOUD && !saveLocal()) {
      S.pk = S.pk.filter(x => x.id !== r.id);
      throw { code: "local" };
    }
  },

  async answerPeakReq(r, ok, note = "") {
    if (ok) {
      if (S.peaks.some(p => lk(p.name) === lk(r.name))) ok = false;
      else await ST.addPeak({ id: nextId(), name: r.name, alt: fixAlt(r.alt), area: r.area || "—" });
    }

    const st = ok ? "ok" : "no";

    if (CLOUD) await withTO(DB.doc("peakreqs/" + r.id).update({ status: st, note: ok ? "" : note }));

    const x = S.pk.find(v => v.id === r.id);

    if (x) {
      x.status = st;
      x.note = ok ? "" : note;
    }

    if (!CLOUD && !saveLocal()) throw { code: "local" };

    return ok;
  },

  async delPeakReq(id) {
    if (CLOUD) await withTO(DB.doc("peakreqs/" + id).delete());

    S.pk = S.pk.filter(x => x.id !== id);

    if (!CLOUD && !saveLocal()) throw { code: "local" };
  },

  watchPeakReqs(cb) {
    if (!CLOUD) {
      cb(S.pk);

      const f = e => {
        if (e.key !== KEY) return;

        try {
          cb(JSON.parse(e.newValue || "{}").pk || []);
        } catch (_) {}
      };

      addEventListener("storage", f);

      return () => removeEventListener("storage", f);
    }

    // Cada usuario solo vigila SUS solicitudes de cima; el administrador, todas.
    const col = DB.collection("peakreqs"),
      q = S.session && S.session.role === "admin" ? col : col.where("userK", "==", lk(S.session.username));

    return q.onSnapshot(
      s => cb(s.docs.map(d => d.data())),
      () => {}
    );
  },

  async ovSave(id, o) {
    if (CLOUD) await withTO(DB.doc("peaksov/" + id).set({ id, name: o.name, alt: o.alt, area: o.area, del: !!o.del }));

    const prev = S.eov[id];

    S.eov[id] = { name: o.name, alt: o.alt, area: o.area, ...(o.del ? { del: true } : {}) };

    rebuild();

    if (!CLOUD && !saveLocal()) {
      if (prev) S.eov[id] = prev;
      else delete S.eov[id];

      rebuild();

      throw { code: "local" };
    }
  },

  async delPeak(id) {
    if (SEED.some(x => x.id === id)) {
      const c = S.peaks.find(x => x.id === id);

      if (!c) return;

      return ST.ovSave(id, { name: c.name, alt: c.alt, area: c.area, del: true });
    }

    if (CLOUD) await withTO(DB.doc("peaks/" + id).delete());

    S.extra = S.extra.filter(p => p.id !== id);

    rebuild();

    if (!CLOUD && !saveLocal()) throw { code: "local" };
  },

  async updatePeak(p) {
    if (SEED.some(x => x.id === p.id)) return ST.ovSave(p.id, { name: p.name, alt: p.alt, area: p.area });

    if (CLOUD) await withTO(DB.doc("peaks/" + p.id).update({ name: p.name, alt: p.alt, area: p.area }));

    const i = S.extra.findIndex(x => x.id === p.id);

    if (i < 0) throw { code: "not-found" };

    const prev = S.extra[i];

    S.extra[i] = { ...prev, ...p };

    rebuild();

    if (!CLOUD && !saveLocal()) {
      S.extra[i] = prev;
      rebuild();
      throw { code: "local" };
    }
  },

  async addPeak(p) {
    if (CLOUD) {
      await withTO(DB.doc("peaks/" + p.id).set(p));
    }

    S.extra.push(p);

    rebuild();

    if (!CLOUD && !saveLocal()) {
      S.extra.pop();
      rebuild();
      throw { code: "local" };
    }
  }
};

let LANG = (() => {
  try {
    const l = localStorage.getItem("cims-lang");

    if (l) return l;
  } catch (e) {}

  return /^ca/i.test(navigator.language || "") ? "ca" : "es";
})();

document.documentElement.lang = LANG;

if (LANG === "ca") document.title = "Repte 100 Cims";

const D = {
  es: {
    onbT: ["Registra tus cimas", "Sube con amigos", "Completa el reto"],
    onbX: [
      "Marca cada cima que hagas con fecha, notas y fotos.",
      "Añade acompañantes y compara tu progreso en el ranking.",
      "Llega a 100 cimas esenciales y desbloquea logros por el camino."
    ],
    next: "Siguiente",
    skip: "Saltar",
    start: "Empezar",
    noRes: "Ninguna cima coincide con tu búsqueda.",
    noFr: "Aún no tienes amigos. ¡Búscalos arriba!",
    delT: "Borrar mi cuenta y mis datos",
    delX: "Se eliminarán tu cuenta, tus cimas, fotos y amistades. No se puede deshacer.",
    pw: "Tu contraseña",
    del: "Borrar definitivamente",
    cancel: "Cancelar",
    bad: "Contraseña incorrecta.",
    gone: "Cuenta eliminada.",
    fab: "Registrar cima",
    big: "El registro es demasiado grande. Quita alguna foto o acorta las notas.",
    more: "Mostrar más",
    pwT: "Cambiar contraseña",
    pwOld: "Contraseña actual",
    pwNew: "Nueva contraseña (mín. 6 caracteres)",
    pwRep: "Repite la nueva contraseña",
    pwSave: "Guardar",
    pwMis: "Las contraseñas no coinciden.",
    pwShort: "La nueva contraseña necesita al menos 6 caracteres.",
    pwOk: "Contraseña cambiada.",
    shr: "Compartir",
    wx: "Previsión Meteocat",
    copied: "Texto copiado al portapapeles"
  },
  ca: {
    onbT: ["Registra les teves cims", "Puja amb amics", "Completa el repte"],
    onbX: [
      "Marca cada cim que facis amb data, notes i fotos.",
      "Afegeix acompanyants i compara el teu progrés al rànquing.",
      "Arriba a 100 cims essencials i desbloqueja assoliments pel camí."
    ],
    next: "Següent",
    skip: "Omet",
    start: "Comença",
    noRes: "Cap cim coincideix amb la teva cerca.",
    noFr: "Encara no tens amics. Cerca'ls a dalt!",
    delT: "Esborra el meu compte i les meves dades",
    delX: "S'eliminaran el teu compte, les teves cims, fotos i amistats. No es pot desfer.",
    pw: "La teva contrasenya",
    del: "Esborra definitivament",
    cancel: "Cancel·la",
    bad: "Contrasenya incorrecta.",
    gone: "Compte eliminat.",
    fab: "Registra una cim",
    big: "El registre és massa gran. Treu alguna foto o escurça les notes.",
    more: "Mostra'n més",
    pwT: "Canvia la contrasenya",
    pwOld: "Contrasenya actual",
    pwNew: "Nova contrasenya (mín. 6 caràcters)",
    pwRep: "Repeteix la nova contrasenya",
    pwSave: "Desa",
    pwMis: "Les contrasenyes no coincideixen.",
    pwShort: "La nova contrasenya necessita almenys 6 caràcters.",
    pwOk: "Contrasenya canviada.",
    shr: "Comparteix",
    wx: "Previsió Meteocat",
    copied: "Text copiat al porta-retalls"
  }
};

const t = k => D[LANG][k];

const CAS = [
  ["acompañado de amigos", "acompanyat d'amics"],
  [
    "Completa todas las cimas esenciales de una comarca (mejor avance en %)",
    "Completa totes les cims essencials d'una comarca (millor avanç en %)"
  ],
  ["Señor de la comarca", "Senyor de la comarca"],
  ["¿Falta una cima en el catálogo?", "Falta una cim al catàleg?"],
  [
    "Pídesela al admin indicando su nombre, altitud y comarca.",
    "Demana-la a l'admin indicant-ne el nom, l'altitud i la comarca."
  ],
  [
    "Si la acepta, aparecerá como cima no esencial (no cuenta para el reto de los 100).",
    "Si l'accepta, apareixerà com a cim no essencial (no compta per al repte dels 100)."
  ],
  ["no cuenta para el reto de los 100", "no compta per al repte dels 100"],
  ["Otro nombre (no hace falta que sea amigo)", "Un altre nom (no cal que sigui amic)"],
  ["amigos", "amics"],
  ["amigo", "amic"],
  ["Sal temprano y fija una hora de retorno.", "Surt d'hora i fixa una hora de tornada."],
  [
    "Lleva agua, comida, abrigo, frontal y calzado de montaña.",
    "Porta aigua, menjar, roba d'abric, frontal i calçat de muntanya."
  ],
  ["Avisa a alguien de tu ruta y compañía.", "Avisa algú de la teva ruta i companyia."],
  [
    "A esta altitud puede haber nieve, hielo o tormentas aun en verano.",
    "A aquesta altitud pot haver-hi neu, gel o tempestes fins i tot a l'estiu."
  ],
  ["Consejos generales, no específicos de esta cima.", "Consells generals, no específics d'aquesta cim."],
  ["y el estado de la ruta el mismo día.", "i l'estat de la ruta el mateix dia."],
  [
    "Pulsa una insignia para ver qué necesitas para desbloquearla.",
    "Toca una insígnia per veure què necessites per desbloquejar-la."
  ],
  ["Toca un usuario para ver todo su progreso.", "Toca un usuari per veure tot el seu progrés."],
  ["Completa tu primera cima para ver estadísticas.", "Completa la teva primera cim per veure estadístiques."],
  ["Completa tu primera cima", "Completa la teva primera cim"],
  ["Empieza tu primera cima", "Comença la teva primera cim"],
  ["Añade amigos para competir con ellos.", "Afegeix amics per competir-hi."],
  [
    "Aún no hay actividad. Añade amigos desde la pestaña Amigos.",
    "Encara no hi ha activitat. Afegeix amics des de la pestanya Amics."
  ],
  ["Aún no hay actividad.", "Encara no hi ha activitat."],
  ["Aún no hay usuarios registrados.", "Encara no hi ha usuaris registrats."],
  ["Aún no has pedido ninguna cima.", "Encara no has demanat cap cim."],
  ["Todavía no ha registrado ninguna cima.", "Encara no ha registrat cap cim."],
  ["Cambiar foto", "Canvia la foto"],
  ["Quitar foto", "Treu la foto"],
  ["Quitar fecha", "Treu la data"],
  ["Subir foto", "Puja una foto"],
  ["Mostrar u ocultar contraseña", "Mostra o amaga la contrasenya"],
  ["Condiciones, sensaciones…", "Condicions, sensacions…"],
  ["Nombre de usuario…", "Nom d'usuari…"],
  ["Nombre", "Nom"],
  ["Email", "Correu"],
  ["Contraseña restablecida. Díasela al usuario.", "Contrasenya restablerta. Digues-la a l'usuari."],
  ["El texto no es una copia válida.", "El text no és una còpia vàlida."],
  ["Elige la fecha.", "Tria la data."],
  ["Elige una fecha válida.", "Tria una data vàlida."],
  ["Esa cima ya estaba en el catálogo: solicitud cerrada.", "Aquesta cim ja era al catàleg: sol·licitud tancada."],
  ["Esa cima ya está en el catálogo.", "Aquesta cim ja és al catàleg."],
  ["Escribe al menos 2 letras para buscar.", "Escriu almenys 2 lletres per cercar."],
  ["Escribe el nombre de la cima.", "Escriu el nom de la cim."],
  ["Ese usuario ya existe.", "Aquest usuari ja existeix."],
  ["Indica una altitud válida en metros.", "Indica una altitud vàlida en metres."],
  ["La contraseña necesita al menos 6 caracteres.", "La contrasenya necessita almenys 6 caràcters."],
  ["La fecha no puede ser futura.", "La data no pot ser futura."],
  ["No se ha encontrado a nadie.", "No s'ha trobat ningú."],
  ["Rellena todos los campos.", "Omple tots els camps."],
  ["Selecciona o escribe una comarca válida de la lista.", "Selecciona o escriu una comarca vàlida de la llista."],
  ["Selecciona y copia el texto manualmente.", "Selecciona i copia el text manualment."],
  [
    "Tu cima se guardó, pero no se pudo avisar a tus amigos: ",
    "La teva cim s'ha desat, però no s'ha pogut avisar els teus amics: "
  ],
  ["Usuario o contraseña incorrectos.", "Usuari o contrasenya incorrectes."],
  ["Ya existe una cima con ese nombre.", "Ja existeix una cim amb aquest nom."],
  ["Ya hay una solicitud pendiente para esa cima.", "Ja hi ha una sol·licitud pendent per a aquesta cim."],
  [
    "Exportar: copia el texto y guárdalo en un lugar seguro. Importar: pega una copia y pulsa Importar (solo añade cimas que aún no tengas).",
    "Exporta: copia el text i desa'l en un lloc segur. Importa: enganxa una còpia i prem Importa (només afegeix cims que encara no tinguis)."
  ],
  ["Exportar", "Exporta"],
  ["Importadas", "Importades"],
  ["Importando…", "Important…"],
  ["Importar", "Importa"],
  ["omitidas", "omeses"],
  ["Copiado al portapapeles", "Copiat al porta-retalls"],
  ["Cerrar", "Tanca"],
  ["Marcar como realizada", "Marca com a feta"],
  ["Has completado el reto el ", "Has completat el repte el "],
  ["Ya eres Leyenda del Pirineu.", "Ja ets Llegenda del Pirineu."],
  ["Leyenda del Pirineu", "Llegenda del Pirineu"],
  ["Montañero", "Muntanyenc"],
  ["Cimero", "Cimaire"],
  ["¡CIMA!", "CIM!"],
  ["¡Hola,", "Hola,"],
  [
    "¿Seguro? Pulsa otra vez para borrar usuario y progreso",
    "Segur? Torna a prémer per esborrar l'usuari i el progrés"
  ],
  ["¿Seguro? Pulsa otra vez", "Segur? Torna a prémer"],
  ["Últimas actividades de amigos", "Darreres activitats d'amics"],
  ["subió", "va pujar"],
  ["hiciste", "vas fer"],
  ["hizo", "va fer"],
  ["te ha añadido como acompañante en", "t'ha afegit com a acompanyant a"],
  ["Si confirmas, también contará en tu lista.", "Si confirmes, també comptarà a la teva llista."],
  ["por confirmar", "per confirmar"],
  ["Tienes", "Tens"],
  ["avisos", "avisos"],
  ["aviso", "avís"],
  ["Aviso enviado a", "Avís enviat a"],
  ["sin revisar", "sense revisar"],
  ["solicitudes", "sol·licituds"],
  ["solicitud", "sol·licitud"],
  ["de amistad pendiente", "d'amistat pendent"],
  ["te ha enviado una", "t'ha enviat una"],
  ["Cima añadida a tu lista", "Cim afegida a la teva llista"],
  ["Solicitud enviada. El admin la revisará.", "Sol·licitud enviada. L'admin la revisarà."],
  ["Solicitudes de cimas", "Sol·licituds de cims"],
  ["Solicitudes", "Sol·licituds"],
  ["Solicitud", "Sol·licitud"],
  ["Editar cima no esencial", "Edita cim no essencial"],
  ["Añadir cima no esencial", "Afegeix cim no essencial"],
  ["Buscar usuarios", "Cerca usuaris"],
  ["Ver en mapa", "Veure al mapa"],
  ["Buscar rutas", "Cerca rutes"],
  ["les saldrá la cima cuando la confirmen", "els sortirà la cim quan la confirmin"],
  ["No se pudo conectar con la nube. Inténtalo de nuevo.", "No s'ha pogut connectar amb el núvol. Torna-ho a provar."],
  ["No se pudo guardar. Inténtalo de nuevo.", "No s'ha pogut desar. Torna-ho a provar."],
  ["Este navegador no permite guardar datos.", "Aquest navegador no permet desar dades."],
  [
    "Almacenamiento lleno (¿fotos muy pesadas?). Quita alguna foto.",
    "Emmagatzematge ple (fotos massa pesades?). Treu alguna foto."
  ],
  [
    "Tu acceso a este enlace no permite guardar datos. Pide al propietario acceso de colaborador.",
    "El teu accés a aquest enllaç no permet desar dades. Demana al propietari accés de col·laborador."
  ],
  ["tu cima más alta", "la teva cim més alta"],
  ["suma de altitudes", "suma d'altituds"],
  ["con amigos", "amb amics"],
  ["cimas en ", "cims el "],
  [
    "no esenciales. Las no esenciales no cuentan para el reto de los 100.",
    "no essencials. Les no essencials no compten per al repte dels 100."
  ],
  ["Completa 100 de las", "Completa 100 de les"],
  ["cimas esenciales de la FEEC", "cims essencials de la FEEC"],
  ["del reto", "del repte"],
  ["Haz 5 cimas esenciales en el mismo mes", "Fes 5 cims essencials el mateix mes"],
  ["5 cimas en un mes", "5 cims en un mes"],
  ["Corona 3 cimas de 3.000 m o más", "Corona 3 cims de 3.000 m o més"],
  ["Explorador de comarcas", "Explorador de comarques"],
  ["Visita 10 comarcas distintas", "Visita 10 comarques diferents"],
  ["Insignia Mes de oro", "Insígnia Mes d'or"],
  ["Insignia Tresmilero", "Insígnia Tresmilenc"],
  ["Insignia", "Insígnia"],
  ["Haz", "Fes"],
  ["Corona una cima de 3000 m o más", "Corona una cim de 3000 m o més"],
  ["Conseguido", "Aconseguit"],
  ["Mis cimas realizadas", "Els meus cims fets"],
  ["Mis cimas", "Els meus cims"],
  ["de tus deseadas", "de les teves desitjades"],
  ["la pendiente más accesible", "la més accessible que et queda"],
  ["Tus notas", "Les teves notes"],
  ["En solitario", "En solitari"],
  ["en solitario", "en solitari"],
  ["Sin fecha", "Sense data"],
  ["Estado", "Estat"],
  ["Tipo", "Tipus"],
  ["Último registro", "Darrer registre"],
  ["cifrada, no se puede ver. Usa «Restablecer» más abajo", "xifrada, no es pot veure. Usa «Restableix» més avall"],
  ["Restablecer", "Restableix"],
  ["Eliminar usuario", "Elimina l'usuari"],
  ["Confirmar", "Confirma"],
  ["Nube", "Núvol"],
  ["Te faltan", "Et falten"],
  ["Abrir ficha de", "Obre la fitxa de"],
  ["acompañante", "acompanyant"],
  ["hace ", "fa "],
  [" días", " dies"],
  [" meses", " mesos"],
  ["ayer", "ahir"],
  ["hoy", "avui"],
  ["Reto", "Repte"],
  ["previsión de Meteocat", "previsió de Meteocat"],
  [
    "Modo local: los datos solo se guardan en este navegador.",
    "Mode local: les dades només es guarden en aquest navegador."
  ],
  [
    "Tus datos se guardan en la nube: puedes entrar desde cualquier dispositivo.",
    "Les teves dades es guarden al núvol: pots entrar des de qualsevol dispositiu."
  ],
  ["Desbloqueada", "Desbloquejada"],
  ["Para conseguirla", "Per aconseguir-la"],
  ["Iniciar sesión", "Inicia la sessió"],
  ["Registrarse", "Registra't"],
  ["Usuario", "Usuari"],
  ["Contraseña (mín. 6 caracteres)", "Contrasenya (mín. 6 caràcters)"],
  ["Contraseña", "Contrasenya"],
  ["Entrar", "Entra"],
  ["Crear cuenta", "Crea el compte"],
  ["Registra tus cimas de Catalunya", "Registra les teves cims de Catalunya"],
  ["Salir", "Surt"],
  ["Inicio", "Inici"],
  ["Retos", "Reptes"],
  ["Amigos", "Amics"],
  ["Buscar cima o comarca…", "Cerca cim o comarca…"],
  ["Todas las comarcas", "Totes les comarques"],
  ["Todas", "Totes"],
  ["Completadas", "Completades"],
  ["Pendientes", "Pendents"],
  ["Deseadas", "Desitjades"],
  ["No esenciales", "No essencials"],
  ["Esenciales", "Essencials"],
  ["esenciales", "essencials"],
  ["Esencial", "Essencial"],
  ["esencial", "essencial"],
  ["Cualquier tipo", "Qualsevol tipus"],
  ["Orden:", "Ordre:"],
  ["Catálogo", "Catàleg"],
  ["Fecha", "Data"],
  ["Altura", "Alçada"],
  ["Hecha", "Feta"],
  ["Editar", "Edita"],
  ["Guardar cima", "Desa la cim"],
  ["Quitar", "Treu"],
  ["Notas", "Notes"],
  ["Acompañantes", "Acompanyants"],
  ["Añadir foto", "Afegeix foto"],
  ["Añadir", "Afegeix"],
  ["Nadie", "Ningú"],
  ["Solo (sin acompañantes)", "Sol (sense acompanyants)"],
  ["Otras subidas (si repites la cima)", "Altres ascensions (si repeteixes la cim)"],
  ["Otras subidas", "Altres ascensions"],
  ["Sin resultados", "Sense resultats"],
  ["Filtros", "Filtres"],
  ["Mis solicitudes", "Les meves sol·licituds"],
  ["Solicitar una cima", "Sol·licita una cim"],
  ["Solicitar cima", "Sol·licita cim"],
  ["Copia de seguridad", "Còpia de seguretat"],
  ["Mis logros", "Els meus assoliments"],
  ["Logros", "Assoliments"],
  ["logros", "assoliments"],
  ["Insignias", "Insígnies"],
  ["Estadísticas", "Estadístiques"],
  ["Cimas por mes", "Cims per mes"],
  ["Comarcas más avanzadas", "Comarques més avançades"],
  ["Ranking entre amigos", "Rànquing entre amics"],
  ["Ranking", "Rànquing"],
  ["Actividad reciente", "Activitat recent"],
  ["Actividad", "Activitat"],
  ["Mis amigos", "Els meus amics"],
  ["Solicitudes recibidas", "Sol·licituds rebudes"],
  ["Aceptar", "Accepta"],
  ["Rechazar", "Rebutja"],
  ["Eliminar", "Elimina"],
  ["Cambiar", "Canvia"],
  ["Tu avatar", "El teu avatar"],
  ["Próxima cima sugerida", "Propera cim suggerida"],
  ["Usuarios registrados", "Usuaris registrats"],
  ["Seguir subiendo", "Continua pujant"],
  ["¿Seguro?", "Segur?"],
  ["Pendiente", "Pendent"],
  ["Aceptada", "Acceptada"],
  ["Rechazada", "Rebutjada"],
  ["Altitud", "Altitud"],
  ["Comarca", "Comarca"],
  ["Información", "Informació"],
  ["Consejos", "Consells"],
  ["Enviar solicitud al admin", "Envia la sol·licitud a l'admin"],
  ["Motivo", "Motiu"],
  ["Cimas", "Cims"],
  ["cimas", "cims"],
  ["Cima", "Cim"],
  ["cima", "cim"],
  ["Cargando", "Carregant"],
  ["Hola,", "Hola,"],
  ["Este mes", "Aquest mes"],
  ["este mes", "aquest mes"],
  ["Tú", "Tu"],
  [": revísalo en Admin", ": revisa-ho a Admin"],
  ["Entiendo que este cambio afecta a todos los usuarios.", "Entenc que aquest canvi afecta tots els usuaris."],
  [
    "Ese nombre de usuario no se puede usar. Prueba con otro.",
    "Aquest nom d'usuari no es pot fer servir. Prova'n un altre."
  ],
  ["Esta cuenta no tiene permisos de administrador.", "Aquest compte no té permisos d'administrador."],
  [
    "Este navegador no puede cifrar contraseñas (usa una conexión https).",
    "Aquest navegador no pot xifrar contrasenyes (usa una connexió https)."
  ],
  ["Fotos (máx. 4)", "Fotos (màx. 4)"],
  ["Se añadirá al catálogo de todos los usuarios.", "S'afegirà al catàleg de tots els usuaris."],
  ["Se cambiará para todos los usuarios.", "Es canviarà per a tots els usuaris."],
  ["Tu cuenta no se ha borrado: inténtalo de nuevo.", "El teu compte no s'ha esborrat: torna-ho a provar."],
  [
    "Tu cuenta no se ha borrado: vuelve a entrar e inténtalo de nuevo.",
    "El teu compte no s'ha esborrat: torna a entrar i torna-ho a provar."
  ],
  ["(mín. 6 caracteres)", "(mín. 6 caràcters)"],
  ["no ha sido aceptada", "no ha estat acceptada"],
  ["ha sido aceptada", "ha estat acceptada"],
  ["Tu solicitud de", "La teva sol·licitud de"],
  [
    "Demasiados intentos. Espera unos minutos y vuelve a probar.",
    "Massa intents. Espera uns minuts i torna-ho a provar."
  ],
  [
    "El acceso con usuario y contraseña no está activado en Firebase (ver README).",
    "L'accés amb usuari i contrasenya no està activat a Firebase (vegeu el README)."
  ],
  [
    "No tienes permiso para hacer eso. Si acabas de actualizar la app, publica las reglas de Firestore (ver README).",
    "No tens permís per fer-ho. Si acabes d'actualitzar l'app, publica les regles de Firestore (vegeu el README)."
  ],
  [
    "El administrador solo está disponible con la base de datos en la nube.",
    "L'administrador només està disponible amb la base de dades al núvol."
  ],
  ["Permitir recuperar la cuenta", "Permet recuperar el compte"],
  [
    "Si alguien olvida su contraseña: pulsa este botón, borra a esa persona en Firebase → Authentication y dile que se registre otra vez con el mismo nombre. Conservará sus cimas y amistades.",
    "Si algú oblida la contrasenya: prem aquest botó, esborra aquesta persona a Firebase → Authentication i digues-li que es torni a registrar amb el mateix nom. Conservarà les seves cims i amistats."
  ],
  [
    "Listo. Ahora borra a este usuario en Firebase → Authentication y dile que se registre con el mismo nombre.",
    "Fet. Ara esborra aquest usuari a Firebase → Authentication i digues-li que es registri amb el mateix nom."
  ],
  [
    "Datos borrados. Para liberar el nombre, borra también a este usuario en Firebase → Authentication.",
    "Dades esborrades. Per alliberar el nom, esborra també aquest usuari a Firebase → Authentication."
  ],
  ["Aún no ha entrado con el sistema nuevo de contraseñas", "Encara no ha entrat amb el sistema nou de contrasenyes"],
  ["Pendiente de migrar", "Pendent de migrar"],
  ["Quitar de deseadas", "Treu de desitjades"],
  ["Marcar como deseada", "Marca com a desitjada"],
  ["Modo claro", "Mode clar"],
  ["Modo oscuro", "Mode fosc"],
  ["Cambiar entre modo claro y oscuro", "Canvia entre mode clar i fosc"],
  ["Compartir", "Comparteix"],
  ["Borrar", "Esborra"],
  ["Anterior", "Anterior"],
  ["Siguiente", "Següent"],
  ["Volver", "Torna"],
  ["Actualizar", "Actualitza"],
  ["Cambiar a castellano", "Canviar a castellà"]
].sort((a, b) => b[0].length - a[0].length);

const fmtD = x => {
  try {
    return new Date(x + "T00:00:00").toLocaleDateString(LANG === "ca" ? "ca-ES" : "es-ES", {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  } catch (e) {
    return x;
  }
};

const trk = x => {
  let o = x;

  for (const [k, v] of CAS) if (o.includes(k)) o = o.split(k).join(v);

  return o;
};

let _pc = 0,
  _pl = [];

const CAK = new Set(CAS.map(p => p[0]));

const prot = () => {
  const n = Date.now();

  if (n - _pc < 400) return _pl;

  _pc = n;

  const st = new Set(),
    add = (v, d) => {
      if (typeof v === "string") {
        if (v.length >= 3 && v.length < 400 && !CAK.has(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) st.add(v);
      } else if (v && typeof v === "object" && d < 4) {
        for (const k in v) add(v[k], d + 1);
      }
    };

  try {
    [S.users, S.done, S.shares, S.pk, S.reqs, S.companions, S.extra].forEach(x => add(x, 0));

    if (S.session) add(S.session.username, 0);

    try {
      add(friends(), 0);
    } catch (e) {}

    try {
      add(ALLU, 0);
    } catch (e) {}
  } catch (e) {}

  _pl = [...st].sort((a, b) => b.length - a.length);

  return _pl;
};

const tr = x => {
  const P = prot().filter(p => x.includes(p));

  if (!P.length) return trk(x);

  const re = new RegExp("(" + P.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g");

  return x
    .split(re)
    .map((g, i) => (i % 2 ? g : trk(g)))
    .join("");
};

const trans = root => {
  if (LANG !== "ca" || !root) return;

  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    L = [];

  let n;

  while ((n = w.nextNode())) L.push(n);

  L.forEach(n => {
    const v = tr(n.nodeValue);

    if (v !== n.nodeValue) n.nodeValue = v;
  });

  root.querySelectorAll("[placeholder],[aria-label],[title]").forEach(e =>
    ["placeholder", "aria-label", "title"].forEach(a => {
      const x = e.getAttribute(a);

      if (x) {
        const y = tr(x);

        if (y !== x) e.setAttribute(a, y);
      }
    })
  );
};

const ICON_LABELS = {
  "🗑": "Borrar",
  "✏": "Editar",
  "⭐": "Quitar de deseadas",
  "☆": "Marcar como deseada",
  "☀": "Modo claro",
  "🌙": "Modo oscuro",
  "👁": "Mostrar u ocultar contraseña",
  "🙈": "Mostrar u ocultar contraseña",
  "➕": "Añadir",
  "📷": "Añadir foto",
  "🔗": "Compartir",
  "📤": "Compartir",
  "‹": "Anterior",
  "›": "Siguiente",
  "←": "Volver",
  "🔄": "Actualizar"
};

const a11y = r => {
  if (r.id === "modal" && !r.getAttribute("role")) {
    r.setAttribute("role", "dialog");
    r.setAttribute("aria-modal", "true");
  }

  r.querySelectorAll("button").forEach(b => {
    if (b.getAttribute("aria-label")) return;

    const tx = (b.textContent || "").trim();

    if (/^[×✕]$/.test(tx)) return b.setAttribute("aria-label", "Cerrar");

    // Botones que solo llevan un emoji: se nombran con su título o con un texto por defecto.
    if (tx && !/\p{L}/u.test(tx)) {
      const l = b.title || ICON_LABELS[tx.replace(/\uFE0F/g, "")];

      if (l) b.setAttribute("aria-label", l);
    }
  });

  r.querySelectorAll("img:not([alt])").forEach(i => i.setAttribute("alt", ""));

  r.querySelectorAll("input,select,textarea").forEach(i => {
    if (i.getAttribute("aria-label") || i.closest("label") || i.type === "hidden") return;

    const l =
      i.placeholder ||
      i.title ||
      (i.options && i.options[0] && i.options[0].text) ||
      (i.previousElementSibling && i.previousElementSibling.textContent) ||
      i.id;

    if (l) i.setAttribute("aria-label", l.trim().slice(0, 60));
  });

  r.querySelectorAll("[data-f],[data-t],[data-o],[data-cf],[data-ft]").forEach(b =>
    b.setAttribute("aria-pressed", /bg-emerald-/.test(b.className) && /text-white/.test(b.className) ? "true" : "false")
  );

  r.querySelectorAll("nav [data-tab],[data-tab].nav").forEach(b => {
    if (b.dataset.tab === S.tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
};

new MutationObserver(m => {
  m.forEach(r =>
    r.addedNodes.forEach(n => {
      if (n.nodeType === 1) {
        a11y(n);

        if (LANG === "ca") trans(n);
      }
    })
  );
}).observe(document.body, { childList: true, subtree: true });

const langBtn = cls =>
  `<button type="button" class="lg font-bold text-sm ${cls.replace("right-3", "right-14")}" aria-label="${LANG === "ca" ? "Cambiar a castellano" : "Canviar a català"}" title="${LANG === "ca" ? "Castellano" : "Català"}">${LANG === "ca" ? "ES" : "CA"}</button>`;

document.addEventListener("click", e => {
  if (e.target.closest(".lg")) {
    LANG = LANG === "ca" ? "es" : "ca";

    try {
      localStorage.setItem("cims-lang", LANG);
    } catch (_) {}

    document.documentElement.lang = LANG;
    document.title = LANG === "ca" ? "Repte 100 Cims" : "Reto 100 Cims";

    render();
  }
});

const ILL = {
  m: '<path d="M4 52l16-24 10 14 12-22 18 32z" fill="var(--brand)" opacity=".85"/><path d="M42 20l-5 8 4-2 3 4 3-4z" fill="#fff"/><circle cx="52" cy="12" r="5" fill="var(--warn)"/>',
  f: '<circle cx="22" cy="22" r="9" fill="var(--brand)"/><circle cx="44" cy="26" r="7" fill="var(--alt)"/><path d="M6 54a16 16 0 0132 0zM36 54a11 11 0 0122 0z" fill="var(--brand)" opacity=".6"/>',
  t: '<path d="M20 8h24v14a12 12 0 01-24 0z" fill="var(--warn)"/><path d="M32 34v12M22 54h20" stroke="var(--brand)" stroke-width="4" stroke-linecap="round"/>'
};

const svgI = (k, z = 72) => `<svg viewBox="0 0 64 64" width="${z}" height="${z}" aria-hidden="true">${ILL[k]}</svg>`;

const empty = (m, k) =>
  `<div class="text-center py-6 text-slate-500"><div class="flex justify-center mb-2">${svgI(k)}</div><p class="text-sm">${m}</p></div>`;

function onboarding() {
  let i = 0;

  const el = document.createElement("div");

  el.id = "modal";
  el.className = "fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-6";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");

  const K = ["m", "f", "t"],
    done = () => {
      try {
        localStorage.setItem("cims-onb", "1");
      } catch (e) {}

      el.remove();
    };

  const paint = () => {
    el.innerHTML = `<div class="sheet bg-white rounded-3xl p-6 text-center max-w-sm w-full space-y-3"><div class="flex justify-center">${svgI(K[i], 120)}</div><h3 class="text-xl font-extrabold">${t("onbT")[i]}</h3><p class="text-sm text-slate-500">${t("onbX")[i]}</p><div class="flex justify-center gap-1.5" aria-hidden="true">${K.map((_, j) => `<i style="width:8px;height:8px;border-radius:9px;background:${j === i ? "var(--brand)" : "var(--line2)"}"></i>`).join("")}</div><div class="flex gap-2"><button id="ok0" class="px-4 rounded-xl bg-slate-100 text-slate-700">${t("skip")}</button><button id="ok1" class="flex-1 bg-emerald-600 text-white rounded-xl py-2.5 font-medium">${i < 2 ? t("next") : t("start")}</button></div></div>`;

    $("#ok0").onclick = done;

    $("#ok1").onclick = () => {
      if (i < 2) {
        i++;
        paint();
      } else done();
    };
  };

  document.body.appendChild(el);

  paint();
}

function openDelAcc() {
  const el = document.createElement("div");

  el.id = "modal";
  el.className = "fixed inset-0 z-50 bg-black/50 flex items-end justify-center";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");

  el.innerHTML = `<div class="sheet bg-white w-full max-w-md rounded-t-3xl p-5 space-y-3"><h3 class="font-bold text-lg text-red-600">${t("delT")}</h3><p class="text-sm text-slate-500">${t("delX")}</p><input id="dpw" type="password" autocomplete="current-password" placeholder="${t("pw")}" class="w-full border rounded-lg px-3 py-2"><p id="dpe" class="text-sm text-red-600 min-h-[1.25rem]"></p><div class="flex gap-2"><button id="dpc" class="px-4 rounded-xl bg-slate-100 text-slate-700">${t("cancel")}</button><button id="dpg" class="flex-1 bg-red-600 text-white rounded-xl py-2.5 font-medium">${t("del")}</button></div></div>`;

  document.body.appendChild(el);

  const close = () => el.remove();

  el.onclick = e => {
    if (e.target === el) close();
  };

  $("#dpc").onclick = close;

  $("#dpg").onclick = async () => {
    const u = S.session.username,
      b = $("#dpg");

    b.disabled = true;

    try {
      // Con Firebase Authentication: se vuelve a comprobar la contraseña, se borran los datos MIENTRAS hay sesión
      // (las reglas lo exigen) y al final se borra la cuenta de acceso.
      if (useAuth()) {
        try {
          await authReauth($("#dpw").value);
        } catch (e0) {
          if (isBadCred(authCode(e0))) {
            $("#dpe").textContent = t("bad");
            b.disabled = false;
            return;
          }

          throw e0;
        }

        for (const r of S.pk.filter(r => r.userK === me())) await ST.delPeakReq(r.id).catch(() => {});

        try {
          await ST.delUser(u);
        } catch (e2) {
          $("#dpe").textContent = errMsg(e2) + " Tu cuenta no se ha borrado: inténtalo de nuevo.";
          b.disabled = false;
          return;
        }

        try {
          await AUTH.currentUser.delete();
        } catch (e3) {}

        close();
        logout();
        toast(t("gone"), "ok");
        return;
      }

      const x = await ST.getUser(u);

      if (!x || !(await verifyPw($("#dpw").value, x.hash))) {
        $("#dpe").textContent = t("bad");
        b.disabled = false;
        return;
      }

      const mine = S.pk.filter(r => r.userK === me());

      close();
      logout();

      for (const r of mine) await ST.delPeakReq(r.id).catch(() => {});

      try {
        await ST.delUser(u);
      } catch (e2) {
        toast(errMsg(e2) + " Tu cuenta no se ha borrado: vuelve a entrar e inténtalo de nuevo.", true);
        return;
      }

      toast(t("gone"), "ok");
    } catch (e) {
      b.disabled = false;

      if ($("#dpe")) $("#dpe").textContent = errMsg(e);
    }
  };
}

const nz = x =>
  String(x)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .trim();

function openChPw() {
  const el = document.createElement("div");

  el.id = "modal";
  el.className = "fixed inset-0 z-50 bg-black/50 flex items-end justify-center";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");

  const inp = (id, k, ac) =>
    `<input id="${id}" type="password" autocomplete="${ac}" placeholder="${t(k)}" class="w-full border rounded-lg px-3 py-2">`;

  el.innerHTML = `<div class="sheet bg-white w-full max-w-md rounded-t-3xl p-5 space-y-3"><h3 class="font-bold text-lg">${t("pwT")}</h3>${inp("cp0", "pwOld", "current-password")}${inp("cp1", "pwNew", "new-password")}${inp("cp2", "pwRep", "new-password")}<p id="cpe" class="text-sm text-red-600 min-h-[1.25rem]"></p><div class="flex gap-2"><button id="cpc" class="px-4 rounded-xl bg-slate-100 text-slate-700">${t("cancel")}</button><button id="cpg" class="flex-1 bg-emerald-600 text-white rounded-xl py-2.5 font-medium">${t("pwSave")}</button></div></div>`;

  document.body.appendChild(el);

  const close = () => el.remove(),
    er = m => {
      $("#cpe").textContent = m;
    };

  el.onclick = e => {
    if (e.target === el) close();
  };

  $("#cpc").onclick = close;

  $("#cpg").onclick = async () => {
    const b = $("#cpg"),
      n1 = $("#cp1").value;

    if (n1.length < 6) return er(t("pwShort"));
    if (n1 !== $("#cp2").value) return er(t("pwMis"));

    b.disabled = true;
    er("");

    try {
      if (useAuth()) {
        try {
          await authChangePassword($("#cp0").value, n1);
        } catch (e0) {
          if (isBadCred(authCode(e0))) {
            er(t("bad"));
            b.disabled = false;
            return;
          }

          throw e0;
        }

        close();
        toast(t("pwOk"), "ok");
        return;
      }

      const x = await ST.getUser(S.session.username);

      if (!x || !(await verifyPw($("#cp0").value, x.hash))) {
        er(t("bad"));
        b.disabled = false;
        return;
      }

      await ST.setPassword(x.username, await hashNew(n1));

      close();
      toast(t("pwOk"), "ok");
    } catch (e) {
      b.disabled = false;
      er(errMsg(e));
    }
  };
}

const esc = s =>
  String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const $ = s => document.querySelector(s);

const TKEY = "cims-theme";

let THEME = null;

try {
  const t = localStorage.getItem(TKEY);

  if (t === "light" || t === "dark") THEME = t;
} catch (e) {}

const sysMQ = matchMedia("(prefers-color-scheme: dark)");

const isDark = () => (THEME ? THEME === "dark" : sysMQ.matches);

const themeIcon = () => (isDark() ? "☀️" : "🌙");

function applyTheme() {
  const r = document.documentElement;

  THEME ? r.setAttribute("data-theme", THEME) : r.removeAttribute("data-theme");

  document.querySelectorAll(".tt").forEach(b => {
    b.textContent = themeIcon();
    b.title = isDark() ? "Modo claro" : "Modo oscuro";
  });
}

function toggleTheme() {
  THEME = isDark() ? "light" : "dark";

  try {
    localStorage.setItem(TKEY, THEME);
  } catch (e) {}

  applyTheme();
}

document.addEventListener("click", e => {
  if (e.target.closest(".tt")) toggleTheme();
});

sysMQ.addEventListener && sysMQ.addEventListener("change", applyTheme);

const themeBtn = cls =>
  langBtn(cls) +
  `<button type="button" class="tt ${cls}" aria-label="Cambiar entre modo claro y oscuro" title="${isDark() ? "Modo claro" : "Modo oscuro"}">${themeIcon()}</button>`;

const nDone = () => S.peaks.filter(p => isEss(p) && S.done[p.id]).length;

let form = null,
  LT = null;

const hash = async t => {
  try {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cims|" + t));

    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    throw { code: "nocrypto" };
  }
};
