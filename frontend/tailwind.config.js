/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        grid: "#0ea5e9",
        solar: "#f59e0b",
        battery: "#10b981",
        tariff: "#ef4444",
      },
    },
  },
  plugins: [],
};
