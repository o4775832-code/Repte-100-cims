/* ===== Autenticación con Firebase Authentication =====

   Cada persona tiene una cuenta de Firebase Authentication. Como la app siempre ha usado
   "nombre de usuario" y no correo, se inicia sesión con un correo sintético:

       <clave del usuario>@users.100cims.invalid

   (la clave es sid(nombre), la misma que el id de su documento users/<clave>; el dominio .invalid
   está reservado y nunca recibe correo). La contraseña ya no se guarda en Firestore: la gestiona
   Firebase. Las reglas (firestore.rules) usan ese correo para saber quién es cada cual.

   Si Firebase Authentication no está disponible (modo local, o la base de datos alternativa),
   useAuth() es false y la app sigue funcionando como antes con los datos del propio navegador. */

const AUTH_DOMAIN = "users.100cims.invalid";
const ADMIN_NAME = "admin_07";

let AUTH = null;

const useAuth = () => CLOUD && !!AUTH;

const authEmail = u => (sid(u) + "@" + AUTH_DOMAIN).toLowerCase(); // Firebase guarda el correo en minúsculas

const authCode = e => (e && e.code) || "";

// Con la "protección contra enumeración de correos" activada, Firebase devuelve invalid-credential
// tanto si la cuenta no existe como si la contraseña es incorrecta.
const isBadCred = c =>
  ["auth/user-not-found", "auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(
    c
  );

function initAuth() {
  try {
    AUTH = window.firebase && firebase.auth ? firebase.auth() : null;
  } catch (e) {
    AUTH = null;
  }
}

// Espera a que Firebase diga si hay una sesión guardada en este navegador.
const authRestore = () =>
  new Promise(res => {
    const un = AUTH.onAuthStateChanged(
      u => {
        un();
        res(u);
      },
      () => res(null)
    );
  });

// El permiso de administrador lo da el servidor: existe un documento admins/<uid> creado desde la consola.
async function authIsAdmin(fu) {
  try {
    return (await withTO(DB.doc("admins/" + fu.uid).get())).exists;
  } catch (e) {
    return false;
  }
}

function enterAdmin() {
  S.session = { role: "admin" };
  S.done = {};
  S.companions = [];
  S.tab = "admin";

  watchPK();
  render();
}

// Cuentas antiguas: la contraseña estaba guardada como hash en el documento del usuario.
// Si la contraseña escrita coincide, se crea su cuenta en Authentication y se borra el hash viejo.
async function migrateLegacy(u, pw) {
  const x = await ST.getUser(u); // sin sesión, las reglas solo dejan ver cuentas antiguas con hash

  if (!x || !x.hash || !(await verifyPw(pw, x.hash))) return false;

  try {
    await withTO(AUTH.createUserWithEmailAndPassword(authEmail(u), pw), 20000);
  } catch (e) {
    if (authCode(e) === "auth/email-already-in-use") return false;

    throw e;
  }

  try {
    await withTO(DB.doc("users/" + sid(u)).update({ hash: fieldDelete() }));
  } catch (e) {}

  return true;
}

// Devuelve { admin: true } o { username }. Lanza errores con "code" que entiende errMsg().
async function loginCloud(u, pw) {
  const admin = lk(u) === ADMIN_NAME;

  try {
    await withTO(AUTH.signInWithEmailAndPassword(authEmail(u), pw), 20000);
  } catch (e) {
    if (!isBadCred(authCode(e))) throw e;

    if (admin || !(await migrateLegacy(u, pw))) throw { code: "bad-credentials" };
  }

  const fu = AUTH.currentUser;

  if (admin) {
    if (!(await authIsAdmin(fu))) {
      await AUTH.signOut();
      throw { code: "not-admin" };
    }

    return { admin: true };
  }

  const x = await ST.getUser(u);

  if (!x) {
    await AUTH.signOut();
    throw { code: "bad-credentials" };
  }

  return { username: x.username };
}

// Crea la cuenta y el documento del usuario. Devuelve el nombre de usuario.
async function registerCloud(u, pw) {
  if (lk(u) === ADMIN_NAME) throw { code: "exists" };

  if (await ST.getUser(u)) throw { code: "exists" }; // cuenta antigua sin migrar: nombre ocupado

  await withTO(AUTH.createUserWithEmailAndPassword(authEmail(u), pw), 20000);

  let x = null;

  try {
    x = await ST.getUser(u);
  } catch (e) {}

  if (x) {
    // El nombre ya tenía datos. Solo se permite si el administrador marcó la cuenta como recuperable.
    if (x.reclaim === true) {
      try {
        await withTO(DB.doc("users/" + sid(u)).update({ reclaim: fieldDelete() }));
      } catch (e) {}

      return x.username;
    }

    try {
      await AUTH.currentUser.delete();
    } catch (e) {
      await AUTH.signOut();
    }

    throw { code: "exists" };
  }

  try {
    await ST.createUser({ username: u, date: new Date().toISOString().slice(0, 10) });
  } catch (e) {
    // Si no se pudo crear el perfil, se deshace la cuenta para no dejar un nombre bloqueado a medias.
    try {
      await AUTH.currentUser.delete();
    } catch (_) {}

    throw e;
  }

  return u;
}

// Sesión recordada por Firebase (sustituye al antiguo "recordar solo el nombre de usuario").
async function resumeCloud(fu) {
  const key = String(fu.email || "").split("@")[0];

  if (key === sid(ADMIN_NAME)) {
    if (await authIsAdmin(fu)) {
      enterAdmin();
      return true;
    }

    await AUTH.signOut();
    return false;
  }

  const s = await withTO(DB.doc("users/" + key).get());

  if (s.exists) {
    await enter(s.data().username);
    return true;
  }

  await AUTH.signOut();
  return false;
}

// Vuelve a pedir la contraseña a quien ya está dentro (para cambiarla o borrar la cuenta).
async function authReauth(pw) {
  const fu = AUTH.currentUser;

  await withTO(fu.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(fu.email, pw)), 20000);

  return fu;
}

async function authChangePassword(oldPw, newPw) {
  const fu = await authReauth(oldPw);

  await withTO(fu.updatePassword(newPw), 20000);
}
