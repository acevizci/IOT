/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)"
        },
        border: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)"
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
          accent: "var(--text-accent)",
          success: "var(--text-success)",
          warning: "var(--text-warning)",
          danger: "var(--text-danger)"
        }
      }
    }
  },
  plugins: []
}
