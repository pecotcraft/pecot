"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  { languageOptions: { sourceType: "commonjs", globals: globals.node } },
  { files: ["**/*.mjs"], languageOptions: { sourceType: "module" } },
];
