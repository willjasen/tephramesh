import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  banner: {
    js: "/* Generated file. Source: https://github.com/willjasen/tephramesh */",
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian owns these runtime singletons. Bundling another CodeMirror copy
  // makes its extension objects fail Obsidian's instanceof checks.
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtinModules],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
