/**
 * Serves the Windows applet .exe (PLAN 1.5, 7.3).
 *
 * `scripts/build-windows.sh` drops the binary into `server/public/download/`, so
 * the dev loop and the product flow are the same path. In production Caddy serves
 * this directory directly; this route keeps `npm run dev` self-contained.
 *
 * Never an S3 public bucket — see PLAN 7.5.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Router } from "express";

const downloadDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/download",
);

export function downloadRouter(): Router {
  const router = express.Router();

  router.use(
    express.static(downloadDir, {
      index: false,
      setHeaders: (res) => {
        res.setHeader("Content-Type", "application/octet-stream");
      },
    }),
  );

  return router;
}
