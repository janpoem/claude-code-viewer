import { cpSync } from "node:fs";

cpSync("dist/static", "electron-dist/static", { recursive: true });
