// The few Node APIs the nightly program uses (src/routine/cli.ts). Declared
// here instead of adding @types/node, whose globals clash with the browser
// types the rest of StudyDesk is checked against.
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, enc: "utf8"): string;
  export function statSync(path: string): { isDirectory(): boolean };
  export function writeFileSync(path: string, data: string | Uint8Array): void;
}
declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], opts: { encoding: "utf8"; timeout?: number; stdio?: unknown }): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(s: string): void };
  exitCode: number | undefined;
};
declare const Buffer: { from(data: ArrayBuffer): Uint8Array };
