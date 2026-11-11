/** Tailwind compilado en local (sustituye al CDN, que compilaba en el navegador en cada visita).
 *  Regenerar con: npm run build:css  (hay que repetirlo si se usan clases nuevas en js/ o index.html) */
export default {
  content: ["./index.html", "./js/**/*.js"],
  theme: { extend: {} },
  plugins: []
};
