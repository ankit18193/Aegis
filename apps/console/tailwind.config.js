/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0d0f12",
        surface: "#14171c",
        "surface-raised": "#1a1e24",
        "surface-hover": "#222730",
        border: "#252b35",
        "border-subtle": "#1d222a",
        muted: "#8892a0",
        foreground: "#e6edf3",
        "foreground-muted": "#9ba6b4",
        accent: {
          DEFAULT: "#2563eb",
          hover: "#1d4ed8",
          subtle: "#172554",
        },
        success: {
          DEFAULT: "#10b981",
          subtle: "rgba(16, 185, 129, 0.12)",
        },
        warning: {
          DEFAULT: "#f59e0b",
          subtle: "rgba(245, 158, 11, 0.12)",
        },
        danger: {
          DEFAULT: "#ef4444",
          subtle: "rgba(239, 68, 68, 0.12)",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          '"SF Mono"',
          "Menlo",
          "Consolas",
          '"Courier New"',
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
