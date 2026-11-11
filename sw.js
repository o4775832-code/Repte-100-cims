/* Service worker de Reto 100 Cims: deja la app instalable y la abre sin conexión.
   - Archivos propios de la app: "primero red, si falla, caché" (así siempre ves la última versión si hay internet).
   - Librerías de Firebase y fuentes: "caché mientras se actualiza".
   - Firestore / Authentication (datos y sesión) NUNCA pasan por aquí: Firebase gestiona su propia caché.
   Sube VERSION cuando cambies archivos para limpiar cachés antiguas. */
const VERSION = "v2";
const CACHE = "cims-" + VERSION;

const SHELL = [
  "./",
  "index.html",
  "manifest.json",
  "css/estilos.css",
  "css/tema.css",
  "css/tailwind.css",
  "js/firebase-config.js",
  "js/catalogo.js",
  "js/estado.js",
  "js/almacenamiento.js",
  "js/amigos.js",
  "js/avatares-celebracion.js",
  "js/seguridad.js",
  "js/autenticacion.js",
  "js/perfil.js",
  "js/retos-ficha.js",
  "js/vistas.js",
  "js/registro.js",
  "js/admin.js",
  "js/arranque.js",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches
      .keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith("cims-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const LIBS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("fetch", e => {
  const req = e.request,
    url = new URL(req.url);

  if (req.method !== "GET") return;

  // Propios: primero red, luego caché.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copia = res.clone();

          if (res.ok) caches.open(CACHE).then(c => c.put(req, copia));

          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match("index.html")))
    );
    return;
  }

  // Librerías y fuentes: lo que haya en caché al momento y se refresca en segundo plano.
  if (LIBS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => {
        const red = fetch(req)
          .then(res => {
            const copia = res.clone();

            if (res.ok || res.type === "opaque") caches.open(CACHE).then(c => c.put(req, copia));

            return res;
          })
          .catch(() => hit);

        return hit || red;
      })
    );
  }
  // El resto (Firestore, Authentication, Meteocat…): sin tocar.
});
