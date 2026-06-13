import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ---- Semantic light-theme tokens ----
        paper: "#FAF7F2", // off-white primary background
        mist: "#E8E8E8", // light grey alternating sections
        panel: "#FFFFFF", // card surface
        ink: {
          DEFAULT: "#2E2E2E", // dark grey body text
          900: "#111111", // near-black headings
          700: "#2E2E2E",
          500: "#5B5B5B",
          400: "#7A7A7A",
        },

        // ---- Legacy token names remapped to the warm palette ----
        // (kept so existing components adopt the new theme automatically)
        abyss: "#FAF7F2", // was deepest bg -> now off-white
        navy: "#FFFFFF", // was surface -> now white panel

        // Primary brand orange
        accent: {
          DEFAULT: "#E58E3A",
          50: "#FDF4EA",
          100: "#FAE4CC",
          200: "#F5C89B", // light orange
          300: "#EFAE6E",
          400: "#EA9C50",
          500: "#E58E3A", // soft orange
          600: "#D97706", // accent / CTA / hover
          700: "#B45309",
          800: "#8A3F08",
          900: "#5C2A06",
        },

        // Secondary warm tone (replaces the old neon green "signal")
        signal: {
          DEFAULT: "#C2410C",
          400: "#EA580C",
          500: "#C2410C",
          600: "#9A3412",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "grid-fade":
          "linear-gradient(to bottom, rgba(250,247,242,0) 0%, rgba(250,247,242,0.9) 90%)",
        "radial-accent":
          "radial-gradient(circle at 50% 0%, rgba(229,142,58,0.12), transparent 60%)",
      },
      boxShadow: {
        glow: "0 18px 45px -20px rgba(217,119,6,0.45)",
        "glow-green": "0 18px 45px -20px rgba(194,65,12,0.4)",
        card: "0 18px 40px -24px rgba(46,46,46,0.25)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-slow": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "1" },
        },
        "grid-pan": {
          "0%": { backgroundPosition: "0 0" },
          "100%": { backgroundPosition: "60px 60px" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        drift: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-80px)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.7s ease-out forwards",
        "pulse-slow": "pulse-slow 4s ease-in-out infinite",
        "grid-pan": "grid-pan 6s linear infinite",
        scan: "scan 4s linear infinite",
        drift: "drift 24s linear infinite alternate",
      },
    },
  },
  plugins: [],
};

export default config;
