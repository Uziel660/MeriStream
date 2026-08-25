import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
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
        display: ["Space Grotesk", "ui-sans-serif", "system-ui"],
        body: ["Inter", "ui-sans-serif", "system-ui"],
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
