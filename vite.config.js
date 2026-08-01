import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  base: "/DialogExtension/", // Wichtig: Groß-/Kleinschreibung muss exakt wie bei GitHub sein!
  server: {
    cors: {
      origin: "https://www.owlbear.rodeo",
    },
  },
});