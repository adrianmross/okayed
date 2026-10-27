// Builds okayed's shadcn registry: node packages/design/scripts/build-registry.mjs <out-dir> [base-url]
//
// Reads registry.source.json and writes one registry item per entry, plus registry.json, the index. Components are
// written here with imports relative to this package; the registry rewrites them to shadcn's aliases
// (@/components/ui, @/lib/utils, @/components/okayed, @/lib/okayed/engine), and the theme is read from okayed.css.
// Then people can install them with: npx shadcn add <base-url>/approval-card.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "dist/r"));
const BASE = (process.argv[3] ?? process.env.OKAYED_REGISTRY_URL ?? "https://okayed.pages.dev/r").replace(/\/$/, "");
const source = JSON.parse(readFileSync(join(ROOT, "registry.source.json"), "utf8"));
const OWN = new Set(source.items.map((i) => i.name));

const SRC = join(ROOT, "src");

/** Where a file of this package lands in a shadcn app, relative to its root (src/okayed/x.tsx → components/okayed/x.tsx). */
const target = (file) => `components/${relative(SRC, file)}`;

/** Component imports, from this package's layout to shadcn's aliases: relative paths resolve, then map by folder. */
function componentImports(code, file) {
  return code
    .replace(/from "(\.\.?\/[\w./-]+)"/g, (whole, spec) => {
      const to = relative(SRC, resolve(dirname(file), spec));
      if (to === "lib/utils") return 'from "@/lib/utils"';
      if (to.startsWith("ui/") || to.startsWith("okayed/")) return `from "@/components/${to}"`;
      return whole;
    })
    .replace(/from "@okayed\/engine"/g, 'from "@/lib/okayed/engine"');
}

/** The engine imports its own files with a .ts extension; most apps don't allow that. */
const libImports = (code) => code.replace(/from "\.\/([\w-]+)\.ts"/g, 'from "./$1"');

function files(item) {
  if (item.dir) {
    const dir = join(ROOT, item.dir);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => ({ path: `${item.target}/${f}`, type: "registry:lib", target: `${item.target}/${f}`, content: libImports(readFileSync(join(dir, f), "utf8")) }));
  }
  return (item.files ?? []).map((p) => {
    const file = join(ROOT, p);
    return { path: target(file), type: "registry:component", target: target(file), content: componentImports(readFileSync(file, "utf8"), file) };
  });
}

// ---------- the theme, from okayed.css ----------

/** A small CSS reader: blocks become { selector, decls, children }. Enough for okayed.css, not for any CSS. */
function parseCss(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  function block() {
    const out = { decls: {}, children: [] };
    let buf = "";
    while (i < text.length) {
      const c = text[i++];
      if (c === "{") {
        const child = block();
        out.children.push({ selector: buf.trim().replace(/\s+/g, " "), ...child });
        buf = "";
      } else if (c === "}") {
        return out;
      } else if (c === ";") {
        const s = buf.trim();
        buf = "";
        const at = s.indexOf(":");
        if (s.startsWith("@")) continue; // @import, @custom-variant: the theme adds its own imports below
        if (at > 0) out.decls[s.slice(0, at).trim()] = s.slice(at + 1).trim();
      } else {
        buf += c;
      }
    }
    return out;
  }
  return block().children;
}

const strip = (decls, keep = () => true) => Object.fromEntries(Object.entries(decls).filter(([k]) => keep(k)).map(([k, v]) => [k.replace(/^--/, ""), v]));

function theme(item) {
  const tree = parseCss(readFileSync(join(ROOT, item.css), "utf8"));
  const find = (sel) => tree.find((b) => b.selector === sel);
  // Only what shadcn's own theme doesn't already define.
  const OKAYED_THEME = /^--(font-(sans|mono)|color-(allow|ask|deny|seal)|animate-|radius-2xl)/;
  const css = {
    '@import "@fontsource-variable/onest"': {},
    '@import "@fontsource-variable/jetbrains-mono"': {},
  };
  for (const b of tree) {
    if (b.selector.startsWith("@keyframes")) css[b.selector] = Object.fromEntries(b.children.map((k) => [k.selector, k.decls]));
    else if (b.selector.startsWith("@media")) css[b.selector] = Object.fromEntries(b.children.map((k) => [k.selector, k.decls]));
    else if (b.selector === "@layer components") css[b.selector] = Object.fromEntries(b.children.map((k) => [k.selector, k.decls]));
    // Of the base layer, only okayed's own touches; shadcn's init already sets borders, body and fonts.
    else if (b.selector === "@layer base") css[b.selector] = Object.fromEntries(b.children.filter((k) => !["*", "html", "body"].includes(k.selector)).map((k) => [k.selector, k.decls]));
  }
  return {
    cssVars: {
      theme: strip(find("@theme inline").decls, (k) => OKAYED_THEME.test(k)),
      light: strip(find(":root").decls),
      dark: strip(find(".dark").decls),
    },
    css,
    dependencies: ["@fontsource-variable/onest", "@fontsource-variable/jetbrains-mono", "tw-animate-css"],
  };
}

// ---------- write ----------

const dep = (name) => (OWN.has(name) ? `${BASE}/${name}.json` : name);

mkdirSync(OUT, { recursive: true });
const index = { $schema: "https://ui.shadcn.com/schema/registry.json", name: source.name, homepage: source.homepage, items: [] };
for (const item of source.items) {
  const out = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: item.name,
    type: item.type,
    title: item.title,
    description: item.description,
    ...(item.dependencies ? { dependencies: item.dependencies } : {}),
    ...(item.registryDependencies ? { registryDependencies: item.registryDependencies.map(dep) } : {}),
    ...(item.css ? theme(item) : { files: files(item) }),
  };
  if (out.files) {
    const stray = out.files.filter((f) => /from "(\.\.\/|@okayed\/)/.test(f.content) || (f.type === "registry:component" && /from "\.\//.test(f.content)));
    if (stray.length) throw new Error(`${item.name}: imports left unrewritten in ${stray.map((f) => f.path).join(", ")}`);
  }
  writeFileSync(join(OUT, `${item.name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  const { files: f, cssVars, css, ...meta } = out;
  index.items.push({ ...meta, ...(f ? { files: f.map(({ content, ...rest }) => rest) } : {}) });
}
writeFileSync(join(OUT, "registry.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`okayed registry: ${source.items.length} items → ${OUT} (${BASE})`);
