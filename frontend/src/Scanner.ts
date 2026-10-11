import { useEffect, useRef } from 'react';
import { api } from './api';
import { Patient } from './types';

// A barcode scanner behaves like a very fast typist who always ends with Enter.
const MAX_GAP_MS = 50;
const MIN_LENGTH = 6;

export interface Product {
  id: string;
  name: string;
  kind: string;
  rate: string;
  gst_rate: string;
}
/** What the server says a scanned code is. */
export type ScanResult = { kind: 'patient'; patient: Patient } | { kind: 'product'; product: Product };

export const looksLikePatientCode = (text: string) => /^(PAT-)?[2-9A-HJKMNP-TV-Z]{10}$/i.test(text.replace(/\s/g, ''));

export function resolveScan(code: string, options: RequestInit = {}) {
  return api<ScanResult>(`scan/${encodeURIComponent(code.trim())}/`, options);
}

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
}

/**
 * Calls `onScan` when a scanner fires while no field is being typed in. A scan into a text field is
 * left alone so it lands where the cursor is, as staff expect; the patient search boxes handle codes
 * themselves.
 */
export function useScanner(active: boolean, onScan: (code: string) => void) {
  const handler = useRef(onScan);
  handler.current = onScan;
  useEffect(() => {
    if (!active) return;
    let buffer = '';
    let last = 0;
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) {
        buffer = '';
        return;
      }
      const now = performance.now();
      if (event.key === 'Enter') {
        const code = buffer;
        buffer = '';
        if (code.length >= MIN_LENGTH && now - last <= MAX_GAP_MS) {
          event.preventDefault();
          handler.current(code);
        }
        return;
      }
      if (event.key.length !== 1) return;
      if (now - last > MAX_GAP_MS) buffer = '';
      buffer += event.key;
      last = now;
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}

/*
 * Where a scanned product goes depends on what is open. A screen that can take products (an open
 * bill, an open visit) claims them while it is on screen; with nothing claiming, a new bill starts.
 */
type ProductTaker = (product: Product) => void;
let productTaker: ProductTaker | null = null;

export const takeScannedProduct = (product: Product) => {
  if (!productTaker) return false;
  productTaker(product);
  return true;
};

/** While the calling screen is open, scanned products are handed to it. */
export function useProductScans(take: ProductTaker) {
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    const taker: ProductTaker = (product) => latest.current(product);
    productTaker = taker;
    return () => {
      if (productTaker === taker) productTaker = null;
    };
  }, []);
}
