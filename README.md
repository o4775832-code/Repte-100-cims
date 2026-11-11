# Reto 100 Cims

Web para registrar las cimas del reto **100 Cims de la FEEC**: marca cada cima con fecha, notas, fotos y acompañantes, compite con tus amigos y desbloquea logros.

## Estructura

```
reto-100-cims/
├── index.html                  # Página principal (carga los CSS y los JS en orden)
├── manifest.json, sw.js        # PWA: instalable y con modo sin conexión
├── icons/                      # Iconos de la app instalada
├── firestore.rules             # Reglas de seguridad de Firestore (se pegan en la consola de Firebase)
├── css/
│   ├── estilos.css             # Estilos base
│   ├── tema.css                # Tema (colores claro/oscuro)
│   └── tailwind.css            # Tailwind COMPILADO (generado; ver "Tailwind")
├── src/tailwind.css            # Entrada de Tailwind
├── js/
│   ├── catalogo.js             # Catálogo de cimas esenciales (datos)
│   ├── estado.js               # Estado global, ajustes y guardado local
│   ├── almacenamiento.js       # Capa de datos (nube / local), traducción al catalán, diálogos de cuenta
│   ├── amigos.js               # Amistades, solicitudes, ranking y actividad
│   ├── avatares-celebracion.js # Avatares, celebración, pantalla de acceso, entrar/salir
│   ├── seguridad.js            # Contraseñas locales (PBKDF2)
│   ├── autenticacion.js        # Firebase Authentication (inicio de sesión, migración, admin)
│   ├── perfil.js               # Iconos, nivel, panel de inicio, perfil, copia de seguridad
│   ├── retos-ficha.js          # Retos y ficha de cada cima
│   ├── vistas.js               # Render principal, insignias, comarcas, inicio
│   ├── registro.js             # Listado de cimas y formulario de registro
│   ├── admin.js                # Panel de administración
│   ├── firebase-config.js      # Configuración de Firebase
│   └── arranque.js             # Arranque de la app, gestos y registro del service worker
├── scripts/
│   ├── copia-seguridad.mjs     # Exporta/restaura Firestore a un JSON
│   └── textos-sin-traducir.mjs # Lista textos en castellano que faltan en la tabla de catalán
└── tests/                      # Pruebas automáticas (npm test)
```

**Importante:** los `<script>` de `index.html` deben cargarse en ese orden, porque comparten variables globales. `arranque.js` va el último y llama a `boot()`.

## Ejecutar en local

Es una web estática. Sirve la carpeta (el service worker y el cifrado de contraseñas necesitan `localhost` o https):

```bash
python3 -m http.server 8000
# y abre http://localhost:8000
```

Para desarrollar (formato, comprobaciones, pruebas): `npm install` una vez y después:

| Comando                | Qué hace                                                                    |
| ---------------------- | --------------------------------------------------------------------------- |
| `npm run format`       | Formatea todo con Prettier                                                  |
| `npm run lint`         | ESLint: avisa de variables que no existen (errores entre archivos)          |
| `npm test`             | Pruebas automáticas (app completa en jsdom con un Firebase falso en memoria) |
| `npm run check`        | lint + pruebas                                                              |
| `npm run build:css`    | Regenera `css/tailwind.css`                                                 |

### Tailwind

Ya no se carga por CDN (compilaba en el navegador en cada visita). `css/tailwind.css` está generado y va en el repositorio.
**Si usas una clase de Tailwind nueva en `js/` o `index.html`, ejecuta `npm run build:css`** y sube el CSS actualizado.
No construyas nombres de clase por partes (`"bg-" + color`): Tailwind solo ve clases escritas completas.

## Publicar en GitHub Pages

1. Sube la carpeta a un repositorio de GitHub (incluye `css/tailwind.css`).
2. En *Settings → Pages*, elige la rama `main` y la carpeta `/ (root)`.
3. La web quedará en `https://TU_USUARIO.github.io/NOMBRE_DEL_REPO/`.

Cuando cambies archivos, sube `VERSION` en `sw.js` (por ejemplo `v3`) para que los móviles descarten la caché antigua.

## Puesta en marcha de la seguridad (hazlo en este orden)

La app ahora usa **Firebase Authentication** y reglas de Firestore **por usuario**. Antes de subir esta versión:

1. **Activa Authentication.** Consola de Firebase → *Authentication → Sign-in method* → activa **Correo electrónico/contraseña** (el enlace por correo no hace falta).
   La app inicia sesión con un correo inventado `usuario@users.100cims.invalid`; nadie recibe correos.
2. **Crea la cuenta del administrador.** *Authentication → Users → Add user*: correo `admin_07@users.100cims.invalid` y una contraseña **nueva y larga** (no reutilices la antigua: su hash estuvo en el código público). Copia el **UID** de ese usuario.
3. **Marca ese UID como administrador.** *Firestore → Iniciar colección* → id `admins` → id de documento = el UID → un campo cualquiera (`enabled` = `true`). Esto solo se puede hacer desde la consola: las reglas impiden crearlo desde la web, y por eso el permiso de admin ya no depende del navegador.
4. **Publica las reglas.** *Firestore → Reglas* → pega `firestore.rules` → **Publicar**.
5. **Sube la web** (GitHub Pages) y **pide a tus amigos que entren cada uno una vez** con su usuario y contraseña de siempre: la app crea su cuenta de acceso y borra el hash antiguo de su documento. Se verá un ⚠️ junto a los usuarios del panel de admin que aún no han entrado.
6. **Cierra la transición.** Cuando ya no quede ningún ⚠️, en `firestore.rules` quita `|| resource == null || 'hash' in resource.data` de la regla `allow get` de `users` (deja `allow get: if signedIn();`) y vuelve a publicar.

Si no activas Authentication o no publicas las reglas, la app mostrará errores de permisos.

**Qué se ha corregido y qué límites tiene**

- Cada persona solo puede modificar *sus* cimas, fotos, perfil y amistades; las reglas lo comprueban en el servidor. Ya no se puede borrar ni editar los datos de otros desde la consola del navegador.
- Se puede seguir *leyendo* los registros y perfiles de otros usuarios que hayan iniciado sesión (hace falta para amigos y ranking). Las contraseñas ya no están en Firestore.
- El ranking se calcula a partir de los registros reales, y un registro solo es válido si su id corresponde a su dueño; el contador `count` es solo informativo.
- **Ventana de migración:** mientras una cuenta antigua no haya entrado por primera vez, alguien que conozca el sistema podría registrarse antes con ese nombre. Por eso el paso 5 conviene hacerlo el mismo día. Pasada la migración, no hay riesgo.
- **Olvidé mi contraseña:** el navegador no puede cambiar la contraseña de otra persona. Flujo: admin → usuario → *Permitir recuperar la cuenta*; borra a esa persona en *Authentication → Users*; la persona se registra de nuevo con el mismo nombre y recupera sus cimas y amistades.
- **Eliminar usuario** (admin) borra sus datos, pero la cuenta de acceso hay que borrarla a mano en *Authentication* para liberar el nombre.
- Nombres con acentos (p. ej. «José»): usan caracteres `~` en el correo sintético. Si Firebase los rechazara (`auth/invalid-email`), el usuario verá «Ese nombre de usuario no se puede usar»; pruébalo con una cuenta de prueba tras publicar.
- Sin Firebase (modo local) el administrador no existe: su permiso solo puede darlo el servidor.

## Base de datos (Firestore)

Colecciones: `users`, `records`, `recphotos`, `friendreqs`, `peakreqs`, `peaks`, `peaksov`, `admins`.

- `recphotos/{usuario}__{cima}` guarda las fotos de cada cima **aparte** del registro: leer registros (los tuyos o los de tus amigos) ya no descarga fotos. Los registros antiguos pasan solos a este formato la primera vez que su dueño entra.
- La app ya no consulta periódicamente la base de datos: usa *listeners* (`onSnapshot`) para las amistades y los registros de tus amigos, y solo recibe los cambios.
- Fotos de cada cima: JPEG de 640 px, y avatares de 128 px (miniaturas). **Firebase Storage** sería lo ideal para fotos, pero hay que comprobar sus condiciones en el plan gratuito actual antes de usarlo; de momento no se necesita.

### Copia de seguridad

`node scripts/copia-seguridad.mjs` exporta todas las colecciones a `copias/copia-FECHA.json` (instrucciones al principio del script; necesita una clave de cuenta de servicio que **no** debes subir a GitHub). Haz una copia cada cierto tiempo y siempre antes de tocar reglas o datos. Con `--restaurar archivo.json` se vuelve a cargar. Las contraseñas viven en Authentication y no se exportan; si hiciera falta restaurar cuentas, usa el flujo de «Permitir recuperar la cuenta».
(Firestore también tiene exportaciones programadas con `gcloud firestore export`, pero requieren el plan de pago.)

## Traducción al catalán

La traducción sigue haciéndose con la tabla `CAS` de `js/almacenamiento.js` (castellano → catalán, frases largas primero). Al añadir textos nuevos ejecuta `node scripts/textos-sin-traducir.mjs`: lista lo que falta (puede haber falsos positivos). Un diccionario por claves sería más robusto, pero obligaría a reescribir todos los textos de la app.

## Accesibilidad y PWA

- `a11y()` en `almacenamiento.js` pone `aria-label` automáticamente a botones que solo llevan un emoji (a partir de su `title` o de una tabla `ICON_LABELS`) y `alt=""` a imágenes decorativas.
- Es instalable (*Añadir a pantalla de inicio*) y la app se abre sin conexión; los datos en la nube necesitan internet (Firestore guarda su propia caché).
