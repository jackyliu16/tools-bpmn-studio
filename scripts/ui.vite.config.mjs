// vite config for the UI harness: stub CSS + raw assets so the REAL
// src/main.js can run under vite-node + jsdom
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    {
      name: 'stub-assets',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.css')) {
          return 'export default "/* stubbed css */";';
        }
        return null;
      },
      load(id) {
        if (id.endsWith('.css') || id.endsWith('.bpmn?raw') || id.endsWith('.json.raw')) {
          if (id.endsWith('.css')) {
            return 'export default "/* stubbed css */";';
          }
          return null;
        }
        return null;
      }
    }
  ]
});