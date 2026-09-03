/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './app.js'],
  theme: {
    extend: {
      colors: { zinc: { 925: '#111114', 950: '#09090b' } },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        pocket: '0 0 60px -15px rgba(16,185,129,0.45)',
        brand: '0 0 80px -25px rgba(99,102,241,0.55)',
      },
      keyframes: {
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-4px)' } },
      },
      animation: { shimmer: 'shimmer 2.5s linear infinite', float: 'float 6s ease-in-out infinite' },
    },
  },
  plugins: [],
};
