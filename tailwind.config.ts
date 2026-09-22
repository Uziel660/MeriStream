import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/*.tsx", "./src/components/**/*.tsx", "./src/hooks/**/*.tsx", "./src/contexts/**/*.tsx"],
  theme: {
    extend: {
      colors: {
        zinc: {
          50: "#f6f8f9", 100: "#eff3f5", 200: "#d5dfe5", 300: "#bac8d1",
          400: "#a3b0b9", 500: "#8194a1", 600: "#5c717f", 700: "#3a4b57",
          800: "#2a353d", 850: "#202b32", 900: "#141b20", 950: "#0c1013",
        },
        amber: {
          100: "#e7f4f8", 200: "#d5edf4", 300: "#c4e5ee", 400: "#b6dce8",
          500: "#a2ccd9", 600: "#7eabba", 700: "#577e8c", 800: "#37535f",
          900: "#263e48", 950: "#142831",
        },
        void: {
          950: "#05070a",
          900: "#0d1117",
          800: "#12161c",
          700: "#1b212b",
          border: "#232a35",
        },
        ink: {
          100: "#e8eaf0",
          400: "#8890a0",
        },
        accent: {
          violet: "#7c5cff",
          "violet-dim": "#5a3fd6",
          mint: "#00e5c7",
        },
        danger: "#ff5470",
      },
      fontFamily: {
        display: ["Manrope", "Segoe UI", "sans-serif"],
        body: ["Manrope", "Segoe UI", "sans-serif"],
        sans: ["Manrope", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 20px 40px -20px rgba(0,0,0,0.6)",
        "card-hover": "0 30px 60px -20px rgba(124,92,255,0.35)",
      },
    },
  },
  plugins: [],
} satisfies Config;
