import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import type { Graph } from './src/types.ts';

const FIXTURE_GRAPH = resolve(import.meta.dirname, '../fixtures/mini.graph.json');
const FIXTURE_ROOT = resolve(import.meta.dirname, '../fixtures/mini');

// Stands in for the Rust server during `npm run dev`, serving the mini fixture.
function fixtureApi(): Plugin {
  return {
    name: 'arachne-fixture-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (url === '/api/graph') {
          res.setHeader('content-type', 'application/json');
          res.end(await readFile(FIXTURE_GRAPH));
          return;
        }
        const m = /^\/api\/source\/(\d+)$/.exec(url);
        if (!m) return next();
        const graph: Graph = JSON.parse(await readFile(FIXTURE_GRAPH, 'utf8'));
        const file = graph.files[Number(m[1])];
        if (!file) {
          res.statusCode = 404;
          res.end('no such file');
          return;
        }
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(await readFile(resolve(FIXTURE_ROOT, file.path)));
      });
    },
  };
}

export default defineConfig({
  plugins: [fixtureApi()],
  build: { outDir: 'dist', emptyOutDir: true },
});
