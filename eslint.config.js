// Configuración de ESLint.
// Los archivos de js/ comparten variables globales (se cargan como <script> clásicos en orden),
// así que calculamos automáticamente la lista de nombres declarados en el nivel superior de
// cada archivo y los damos por "globales conocidos". Así `no-undef` detecta erratas reales
// sin dar falsos positivos por el reparto en varios archivos.
import fs from "node:fs";
import path from "node:path";
import * as espree from "espree";
import globals from "globals";

const dir = path.join(import.meta.dirname, "js");
const shared = {};

const names = pattern => {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap(p => names(p.value || p.argument));
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(names);
  if (pattern.type === "AssignmentPattern") return names(pattern.left);
  if (pattern.type === "RestElement") return names(pattern.argument);
  return [];
};

for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".js"))) {
  const ast = espree.parse(fs.readFileSync(path.join(dir, f), "utf8"), { ecmaVersion: 2022, sourceType: "script" });

  for (const n of ast.body) {
    if (n.type === "VariableDeclaration")
      n.declarations.forEach(d => names(d.id).forEach(x => (shared[x] = "writable")));
    else if (n.type === "FunctionDeclaration" && n.id) shared[n.id.name] = "writable";
  }
}

export default [
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, firebase: "readonly", claude: "readonly", ...shared }
    },
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-unsafe-negation": "error",
      "no-redeclare": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }]
    }
  },
  {
    files: ["sw.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.serviceworker } },
    rules: { "no-undef": "error" }
  }
];
