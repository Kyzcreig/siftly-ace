import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Test files: mocks/fixtures legitimately use `any` for partial Prisma
    // delegate shapes, and intentionally-unused imports are common.
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "e2e/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Allow underscore-prefixed intentionally-unused vars project-wide.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Inherited Siftly UI (Next.js app-router pages + shared components).
    // The React-Compiler-era set-state-in-effect / immutability rules flag
    // legitimate mount-time sync patterns (theme/localStorage/DOM reads) in
    // upstream code we did not author. Keep them visible as warnings rather
    // than failing CI on inherited UI; our own pipeline code (lib/, src/,
    // scripts/) stays under full error enforcement.
    files: ["app/**/*.tsx", "components/**/*.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
]);

export default eslintConfig;
