import { randomUUID } from 'node:crypto';
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());           // Box-Muller
export const jitterMeters = (c, dx, dy) => ({ lat: c.lat + dy / 111320, lng: c.lng + dx / (111320 * Math.cos(c.lat * Math.PI / 180)) });
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const uuid = () => randomUUID();
