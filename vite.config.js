import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  base: "/DialogExtension/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        portrait: "portrait.html",
        display: "display.html"
      }
    }
  },
  server: {
    cors: {
      origin: "https://www.owlbear.rodeo",
    },
  },
});