import firebaseRulesPlugin from "@firebase/eslint-plugin-security-rules";

export default [
  {
    ignores: ["dist/**/*", "node_modules/**/*", "src/**/*", "public/**/*", "data/**/*", "server.ts"]
  },
  firebaseRulesPlugin.configs["flat/recommended"]
];
